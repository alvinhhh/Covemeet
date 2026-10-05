/* Isolated SIP fixture. No physical sound backend, playback, or audio files.
 * Build against pinned pjproject 2.17; see sip-client.md for the wire contract.
 */
#define _POSIX_C_SOURCE 200809L
#include <pjsua-lib/pjsua.h>
#include <pjmedia/transport_srtp.h>
#include <pj/ssl_sock.h>
#include <stdatomic.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <poll.h>
#include <signal.h>
#include <time.h>

#define RATE 8000
#define SAMPLES 160
#define COMMAND_MAX 96

static pjsua_call_id call_id = PJSUA_INVALID_ID;
static pjsua_conf_port_id memory_slot = PJSUA_INVALID_ID;
static pjmedia_port memory_port;
static pj_pool_t *memory_pool;
static atomic_uint_fast64_t received_frames, non_silent_frames, generated_frames;
static atomic_uint peak_sample;
static atomic_int generate_pcm;
static unsigned phase;
static int connected, disconnected, media_connected, last_status;
static int tls_verified, tls_allowed_protocols, tls_cipher, verification_errors;
static int srtp_active, srtp_expected = 1, srtp_suite_confirmed;
static int dtmf_pending, input_closed;
static volatile sig_atomic_t stopping;
static char password[257];

static uint64_t monotonic_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + (unsigned)now.tv_nsec / 1000000;
}
static void stop_signal(int signum) { (void)signum; stopping = 1; }
static void discard_log(int level, const char *data, int len) {
    (void)level; (void)data; (void)len;
}
static void erase(void *ptr, size_t length) {
    volatile unsigned char *p = ptr;
    while (length--) *p++ = 0;
}
static int failure(const char *operation, int status) {
    printf("{\"event\":\"error\",\"operation\":\"%s\",\"status\":%d}\n", operation, status);
    fflush(stdout);
    return 1;
}
static pj_status_t get_frame(pjmedia_port *port, pjmedia_frame *frame) {
    (void)port;
    int16_t *samples = frame->buf;
    size_t count = frame->size / sizeof(*samples);
    const int enabled = atomic_load(&generate_pcm);
    for (size_t i = 0; i < count; ++i) {
        /* Bounded synthetic square wave. It only travels to the private SIP peer. */
        samples[i] = enabled ? (phase < 10 ? 600 : -600) : 0;
        phase = (phase + 1) % 20;
    }
    if (enabled) atomic_fetch_add(&generated_frames, 1);
    frame->type = PJMEDIA_FRAME_TYPE_AUDIO;
    return PJ_SUCCESS;
}
static pj_status_t put_frame(pjmedia_port *port, pjmedia_frame *frame) {
    (void)port;
    if (frame->type != PJMEDIA_FRAME_TYPE_AUDIO || !frame->buf) return PJ_SUCCESS;
    const int16_t *samples = frame->buf;
    unsigned peak = 0;
    for (size_t i = 0; i < frame->size / sizeof(*samples); ++i) {
        const int value = samples[i];
        const unsigned magnitude = value < 0 ? (unsigned)-value : (unsigned)value;
        if (magnitude > peak) peak = magnitude;
    }
    atomic_fetch_add(&received_frames, 1);
    if (peak > 32) atomic_fetch_add(&non_silent_frames, 1);
    unsigned previous = atomic_load(&peak_sample);
    while (peak > previous && !atomic_compare_exchange_weak(&peak_sample, &previous, peak)) {}
    return PJ_SUCCESS;
}
static void media_security(pjsua_call_id id, unsigned index) {
    pjmedia_transport_info info;
    pjmedia_transport_info_init(&info);
    srtp_active = 0;
    srtp_suite_confirmed = 0;
    if (pjsua_call_get_med_transport_info(id, index, &info) != PJ_SUCCESS) return;
    for (unsigned i = 0; i < info.specific_info_cnt; ++i) {
        if (info.spc_info[i].type != PJMEDIA_TRANSPORT_TYPE_SRTP) continue;
        const pjmedia_srtp_info *secure = (const pjmedia_srtp_info *)info.spc_info[i].buffer;
        srtp_active = secure->active;
        srtp_suite_confirmed =
            pj_strcmp2(&secure->tx_policy.name, "AES_CM_128_HMAC_SHA1_80") == 0 &&
            pj_strcmp2(&secure->rx_policy.name, "AES_CM_128_HMAC_SHA1_80") == 0;
        /* Never print the SRTP key fields contained in this structure. */
    }
}
static void transport_state(pjsip_transport *transport, pjsip_transport_state state,
                            const pjsip_transport_state_info *info) {
    if (!(transport->flag & PJSIP_TRANSPORT_SECURE) || !info->ext_info) return;
    const pjsip_tls_state_info *tls = info->ext_info;
    if (!tls->ssl_sock_info) return;
    const pj_ssl_sock_info *ssl = tls->ssl_sock_info;
    verification_errors |= ssl->verify_status;
    if (state == PJSIP_TP_STATE_CONNECTED) {
        /* pjproject 2.17 exposes the configured allow-mask, not the selected TLS version. */
        tls_allowed_protocols = ssl->proto;
        tls_cipher = ssl->cipher;
        tls_verified = ssl->established && ssl->verify_status == 0;
    }
    printf("{\"event\":\"tls\",\"state\":%d,\"verified\":%s,\"allowedProtocols\":%u,\"cipher\":%u,\"verificationErrors\":%u}\n",
           state, tls_verified ? "true" : "false", (unsigned)tls_allowed_protocols,
           (unsigned)tls_cipher, (unsigned)verification_errors);
    fflush(stdout);
}
static void call_state(pjsua_call_id id, pjsip_event *event) {
    (void)event;
    pjsua_call_info info;
    if (pjsua_call_get_info(id, &info) != PJ_SUCCESS) return;
    last_status = info.last_status;
    if (info.state == PJSIP_INV_STATE_CONFIRMED) connected = 1;
    if (info.state == PJSIP_INV_STATE_DISCONNECTED) {
        disconnected = 1;
        atomic_store(&generate_pcm, 0);
    }
    printf("{\"event\":\"call\",\"state\":%d,\"status\":%d,\"connected\":%s,\"disconnected\":%s}\n",
           info.state, last_status, connected ? "true" : "false", disconnected ? "true" : "false");
    fflush(stdout);
}
static void media_state(pjsua_call_id id) {
    pjsua_call_info info;
    if (pjsua_call_get_info(id, &info) != PJ_SUCCESS) return;
    for (unsigned i = 0; i < info.media_cnt; ++i) {
        if (info.media[i].type != PJMEDIA_TYPE_AUDIO || info.media[i].status != PJSUA_CALL_MEDIA_ACTIVE) continue;
        media_security(id, i);
        printf("{\"event\":\"media\",\"srtpActive\":%s,\"srtpSuite\":\"%s\"}\n",
               srtp_active ? "true" : "false", srtp_suite_confirmed ? "AES_CM_128_HMAC_SHA1_80" : "");
        fflush(stdout);
        if (srtp_expected && (!tls_verified || !srtp_active || !srtp_suite_confirmed)) {
            failure("media-security", 0);
            pjsua_call_hangup(id, 488, NULL, NULL);
            return;
        }
        if (!media_connected) {
            const pjsua_conf_port_id call_slot = info.media[i].stream.aud.conf_slot;
            pj_status_t status = pjsua_conf_connect(call_slot, memory_slot);
            if (status == PJ_SUCCESS) status = pjsua_conf_connect(memory_slot, call_slot);
            if (status != PJ_SUCCESS) { failure("memory-audio", status); stopping = 1; return; }
            media_connected = 1;
        }
    }
}
static void stream_created(pjsua_call_id id, pjsua_on_stream_created_param *param) {
    (void)id;
    pjmedia_stream_info info;
    pj_status_t status = pjmedia_stream_get_info(param->stream, &info);
    /* pjproject 2.17 defaults to zero inter-digit pause. Configure the stream
     * before its clock starts so duration, RTP timestamps and the release gap
     * agree, including repeated identical digits. Never deduplicate at the IVR. */
    if (status == PJ_SUCCESS && info.tx_event_pt >= 0)
        status = pjmedia_stream_set_tx_dtmf_options(param->stream, 120, 100,
                                                   (pj_uint8_t)info.tx_event_pt, -10, 2);
    else if (status == PJ_SUCCESS) status = PJ_EINVAL;
    if (status != PJ_SUCCESS) { failure("dtmf-options", status); stopping = 1; }
}
static void incoming_call(pjsua_acc_id account, pjsua_call_id id, pjsip_rx_data *data) {
    (void)account; (void)data;
    pjsua_call_answer(id, 486, NULL, NULL);
}
static void stats(void) {
    pjsua_stream_stat media;
    memset(&media, 0, sizeof(media));
    if (!disconnected && call_id != PJSUA_INVALID_ID) pjsua_call_get_stream_stat(call_id, 0, &media);
    printf("{\"event\":\"stats\",\"connected\":%s,\"disconnected\":%s,\"status\":%d,\"tlsVerified\":%s,\"tlsAllowedProtocols\":%u,\"tlsCipher\":%u,\"verificationErrors\":%u,\"srtpActive\":%s,\"srtpSuiteConfirmed\":%s,\"receivedFrames\":%" PRIuFAST64 ",\"nonSilentFrames\":%" PRIuFAST64 ",\"peak\":%u,\"generatedFrames\":%" PRIuFAST64 ",\"rxPackets\":%u,\"txPackets\":%u}\n",
           connected ? "true" : "false", disconnected ? "true" : "false", last_status,
           tls_verified ? "true" : "false", (unsigned)tls_allowed_protocols, (unsigned)tls_cipher,
           (unsigned)verification_errors, srtp_active ? "true" : "false", srtp_suite_confirmed ? "true" : "false",
           atomic_load(&received_frames), atomic_load(&non_silent_frames), atomic_load(&peak_sample),
           atomic_load(&generated_frames), media.rtcp.rx.pkt, media.rtcp.tx.pkt);
    fflush(stdout);
}
static void command(char *line) {
    if (!strcmp(line, "stats")) { stats(); return; }
    if (!strcmp(line, "hangup")) { stopping = 1; return; }
    if (!strcmp(line, "tone on") || !strcmp(line, "tone off")) {
        atomic_store(&generate_pcm, !strcmp(line, "tone on"));
        puts("{\"event\":\"command\",\"operation\":\"tone\",\"accepted\":true}");
    } else if (!strncmp(line, "dtmf ", 5)) {
        char *digits = line + 5;
        const size_t count = strlen(digits);
        if (!connected || disconnected || count < 1 || count > 32 || strspn(digits, "0123456789*#") != count) {
            failure("dtmf-input", 0);
        } else {
            pjsua_call_send_dtmf_param param;
            pjsua_call_send_dtmf_param_default(&param);
            param.method = PJSUA_DTMF_METHOD_RFC2833;
            param.duration = 0; /* Use the stream duration configured above. */
            param.digits = pj_str(digits);
            const pj_status_t status = pjsua_call_send_dtmf(call_id, &param);
            if (status == PJ_SUCCESS) {
                dtmf_pending = 1;
                puts("{\"event\":\"command\",\"operation\":\"dtmf\",\"accepted\":true}");
            } else failure("dtmf-send", status);
        }
    } else failure("unknown-command", 0);
    fflush(stdout);
}
static int read_password(const char *path) {
    if (!path) return 0;
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    struct stat stat;
    if (fd < 0) return 0;
    if (fstat(fd, &stat) || !S_ISREG(stat.st_mode) || (stat.st_mode & 077) || stat.st_uid != getuid() || stat.st_size < 16 || stat.st_size > 256) {
        close(fd); return 0;
    }
    const ssize_t count = read(fd, password, sizeof(password) - 1);
    close(fd);
    if (count != stat.st_size) return 0;
    size_t length = (size_t)count;
    while (length && (password[length - 1] == '\n' || password[length - 1] == '\r')) password[--length] = 0;
    return length >= 16 && strspn(password, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.") == length;
}
int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGTERM, stop_signal);
    signal(SIGINT, stop_signal);
    signal(SIGPIPE, SIG_IGN);
    const char *host = getenv("SIP_TEST_HOST");
    const char *mode = getenv("SIP_TEST_MODE");
    const char *ca = getenv("SIP_CA_FILE");
    if (!host) host = "asterisk";
    if (!mode) mode = "tls";
    if (!ca) ca = "/certs/ca.crt";
    if (strcmp(host, "asterisk") && strcmp(host, "asterisk-wrong-name")) return failure("host-policy", 0);
    if (strcmp(mode, "tls") && strcmp(mode, "without-srtp") && strcmp(mode, "cleartext")) return failure("mode-policy", 0);
    if (!read_password(getenv("SIP_PASSWORD_FILE"))) return failure("private-password-file", 0);
    const int cleartext = !strcmp(mode, "cleartext");
    srtp_expected = !strcmp(mode, "tls");
    unsigned deadline_ms = 120000;
    if (getenv("SIP_DEADLINE_MS")) {
        char *end;
        const unsigned long value = strtoul(getenv("SIP_DEADLINE_MS"), &end, 10);
        if (*end || value < 1000 || value > 300000) return failure("deadline-policy", 0);
        deadline_ms = (unsigned)value;
    }
    pj_log_set_level(0);
    pj_log_set_log_func(discard_log);
    pj_status_t status = pjsua_create();
    if (status != PJ_SUCCESS) return failure("create", status);
    pjsua_config config;
    pjsua_logging_config logging;
    pjsua_media_config media;
    pjsua_config_default(&config);
    pjsua_logging_config_default(&logging);
    pjsua_media_config_default(&media);
    config.max_calls = 1;
    config.thread_cnt = 0;
    config.cb.on_call_state = call_state;
    config.cb.on_call_media_state = media_state;
    config.cb.on_stream_created2 = stream_created;
    config.cb.on_transport_state = transport_state;
    config.cb.on_incoming_call = incoming_call;
    logging.level = logging.console_level = 0;
    logging.msg_logging = PJ_FALSE;
    logging.cb = discard_log;
    media.clock_rate = media.snd_clock_rate = RATE;
    media.channel_count = 1;
    media.audio_frame_ptime = 20;
    media.no_vad = PJ_TRUE;
    media.ec_tail_len = 0;
    status = pjsua_init(&config, &logging, &media);
    if (status != PJ_SUCCESS) goto failed;
    pjsua_transport_config transport;
    pjsua_transport_config_default(&transport);
    transport.port = 0;
    transport.tls_setting.verify_server = PJ_TRUE;
    transport.tls_setting.ca_list_file = pj_str((char *)ca);
    transport.tls_setting.proto = PJ_SSL_SOCK_PROTO_TLS1_2 | PJ_SSL_SOCK_PROTO_TLS1_3;
    pjsua_transport_id transport_id;
    status = pjsua_transport_create(cleartext ? PJSIP_TRANSPORT_TCP : PJSIP_TRANSPORT_TLS, &transport, &transport_id);
    if (status != PJ_SUCCESS) goto failed;
    status = pjsua_start();
    if (status != PJ_SUCCESS) goto failed;
    status = pjsua_set_null_snd_dev();
    if (status != PJ_SUCCESS) goto failed;
    pjsua_codec_info codecs[64];
    unsigned codec_count = 64;
    status = pjsua_enum_codecs(codecs, &codec_count);
    if (status != PJ_SUCCESS) goto failed;
    for (unsigned i = 0; i < codec_count; ++i) pjsua_codec_set_priority(&codecs[i].codec_id, 0);
    pj_str_t codec = pj_str("PCMU/8000/1");
    status = pjsua_codec_set_priority(&codec, PJMEDIA_CODEC_PRIO_HIGHEST);
    if (status != PJ_SUCCESS) goto failed;
    memory_pool = pjsua_pool_create("fixture-memory", 4096, 4096);
    pj_str_t name = pj_str("programmatic-counter");
    status = pjmedia_port_info_init(&memory_port.info, &name, PJMEDIA_SIG_CLASS_PORT_AUD('T', 'S'), RATE, 1, 16, SAMPLES);
    if (status != PJ_SUCCESS) goto failed;
    memory_port.get_frame = get_frame;
    memory_port.put_frame = put_frame;
    status = pjsua_conf_add_port(memory_pool, &memory_port, &memory_slot);
    if (status != PJ_SUCCESS) goto failed;
    pjsua_acc_config account;
    pjsua_acc_config_default(&account);
    account.id = pj_str("sip:syntheticclient@asterisk");
    account.transport_id = transport_id;
    account.register_on_acc_add = PJ_FALSE;
    account.cred_count = 1;
    account.cred_info[0].realm = pj_str("*");
    account.cred_info[0].scheme = pj_str("digest");
    account.cred_info[0].username = pj_str("syntheticclient");
    account.cred_info[0].data_type = PJSIP_CRED_DATA_PLAIN_PASSWD;
    account.cred_info[0].data = pj_str(password);
    account.use_srtp = srtp_expected ? PJMEDIA_SRTP_MANDATORY : PJMEDIA_SRTP_DISABLED;
    account.srtp_secure_signaling = cleartext ? 0 : 1;
    account.srtp_opt.keying_count = 1;
    account.srtp_opt.keying[0] = PJMEDIA_SRTP_KEYING_SDES;
    account.srtp_opt.crypto_count = 1;
    account.srtp_opt.crypto[0].name = pj_str("AES_CM_128_HMAC_SHA1_80");
    pjsua_acc_id account_id;
    status = pjsua_acc_add(&account, PJ_TRUE, &account_id);
    erase(password, sizeof(password));
    if (status != PJ_SUCCESS) goto failed;
    char target[128];
    snprintf(target, sizeof(target), "sip:7000@%s:%u;transport=%s", host, cleartext ? 5060 : 5061, cleartext ? "tcp" : "tls");
    pj_str_t uri = pj_str(target);
    pjsua_call_setting settings;
    pjsua_call_setting_default(&settings);
    settings.aud_cnt = 1;
    settings.vid_cnt = 0;
    status = pjsua_call_make_call(account_id, &uri, &settings, NULL, NULL, &call_id);
    if (status != PJ_SUCCESS) goto failed;
    puts("{\"event\":\"started\",\"soundDevice\":\"null\",\"audioSink\":\"memory-counters\"}");
    const uint64_t end = monotonic_ms() + deadline_ms;
    char line[COMMAND_MAX];
    size_t length = 0;
    while (!stopping && !disconnected && monotonic_ms() < end) {
        pjsua_handle_events(20);
        if (dtmf_pending) {
            unsigned queued = 0;
            if (pjsua_call_get_queued_dtmf_digits(call_id, &queued) == PJ_SUCCESS && !queued) {
                dtmf_pending = 0;
                puts("{\"event\":\"dtmf-drained\"}");
            }
        }
        struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
        if (!input_closed && poll(&input, 1, 0) > 0) {
            char bytes[COMMAND_MAX];
            const ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
            if (count <= 0) { input_closed = 1; stopping = 1; }
            for (ssize_t i = 0; i < count; ++i) {
                if (bytes[i] == '\n') {
                    line[length] = 0;
                    command(line);
                    erase(line, sizeof(line));
                    length = 0;
                } else if (bytes[i] != '\r' && length < sizeof(line) - 1) line[length++] = bytes[i];
                else if (bytes[i] != '\r') { failure("command-length", 0); stopping = 1; break; }
            }
            erase(bytes, sizeof(bytes));
        }
    }
    if (!stopping && !disconnected) failure("deadline", 0);
    atomic_store(&generate_pcm, 0);
    stats();
    pjsua_call_hangup_all();
    for (unsigned i = 0; i < 50 && pjsua_call_get_count(); ++i) pjsua_handle_events(20);
    pjsua_destroy();
    erase(password, sizeof(password));
    puts("{\"event\":\"stopped\"}");
    return 0;
failed:
    failure("sip-initialize-or-dial", status);
    atomic_store(&generate_pcm, 0);
    pjsua_destroy();
    erase(password, sizeof(password));
    return 1;
}
