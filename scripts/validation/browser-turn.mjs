// Local opt-in fixture only; mounted by compose.local-turn.yaml, never a production asset.
const params = new URLSearchParams(location.hash.slice(1));
const code = params.get("code"),
  hostToken = params.get("host"),
  relayTransport = params.get("transport") ?? "tls";
history.replaceState(null, "", location.pathname);
const button = document.querySelector("#run"),
  output = document.querySelector("#results");
const report = {
  result: "ready",
  requiredRelayTransport: relayTransport,
  generatedVideoOnly: true,
  deviceAccess: false,
  mediaPlayback: false,
  ice: {
    configurations: 0,
    tlsServers: 0,
    udpServers: 0,
    candidateTypes: {},
    errors: [],
    states: [],
  },
};
const render = () => {
  output.textContent = JSON.stringify(report, null, 2);
};
if (
  location.origin !== "https://meet.localhost:8443" ||
  !/^[a-z0-9_-]{4,64}$/i.test(code ?? "") ||
  !hostToken ||
  !["tls", "udp"].includes(relayTransport)
) {
  report.result = "A prepared local meeting link is required.";
} else button.disabled = false;
render();
document.querySelector("#description").textContent =
  `Publishes synthetic video through local TURN/${relayTransport.toUpperCase()}. No camera, microphone or playback.`;

const peers = new Set();
const NativePeerConnection = window.RTCPeerConnection;
function relayOnly(config = {}) {
  const filtered = {
    ...config,
    iceTransportPolicy: "relay",
    iceServers: (config.iceServers ?? [])
      .map((server) => ({
        ...server,
        // LiveKit 1.13.7 always advertises embedded TLS TURN on 443. The
        // local fixture publishes that same listener on loopback port 15349.
        urls: (Array.isArray(server.urls) ? server.urls : [server.urls])
          .map((url) =>
            url.replace(
              /^turns:meet\.localhost:443(?=\?|$)/,
              "turns:meet.localhost:15349",
            ),
          )
          .filter((url) =>
            relayTransport === "tls"
              ? /^turns:meet\.localhost:15349(?:\?transport=tcp)?$/.test(url)
              : /^turn:127\.0\.0\.1:13478(?:\?transport=udp)?$/.test(url),
          ),
      }))
      .filter((server) => server.urls.length),
  };
  report.ice.configurations++;
  report.ice[relayTransport === "tls" ? "tlsServers" : "udpServers"] +=
    filtered.iceServers.length;
  return filtered;
}
// Restrict the SDK's authenticated server grants at the native browser boundary,
// including configuration updates. The credentials themselves are never changed.
window.RTCPeerConnection = class extends NativePeerConnection {
  constructor(config, constraints) {
    super(relayOnly(config), constraints);
    peers.add(this);
    this.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      const kind = event.candidate.type ?? "unknown";
      report.ice.candidateTypes[kind] =
        (report.ice.candidateTypes[kind] ?? 0) + 1;
    });
    this.addEventListener("icecandidateerror", (event) => {
      if (report.ice.errors.length < 8) report.ice.errors.push(event.errorCode);
    });
    this.addEventListener("iceconnectionstatechange", () => {
      if (report.ice.states.length < 12)
        report.ice.states.push(this.iceConnectionState);
    });
  }
  setConfiguration(config) {
    super.setConfiguration(relayOnly(config));
  }
};
async function api(suffix, body = {}) {
  const response = await fetch(
    `/api/meetings/${encodeURIComponent(code)}${suffix}`,
    {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "MeetingPlatform",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error(`API ${suffix} returned ${response.status}`);
  return response.json();
}
async function selectedRoute() {
  for (const peer of peers) {
    const stats = await peer.getStats();
    let bytes = 0;
    for (const row of stats.values())
      if (row.type === "outbound-rtp" && row.kind === "video")
        bytes += row.bytesSent ?? 0;
    if (!bytes) continue;
    for (const transport of stats.values()) {
      if (transport.type !== "transport" || transport.dtlsState !== "connected")
        continue;
      const pair = stats.get(transport.selectedCandidatePairId),
        candidate = stats.get(pair?.localCandidateId);
      if (!candidate) continue;
      if (
        candidate.candidateType !== "relay" ||
        candidate.relayProtocol !== relayTransport
      )
        throw new Error(
          `Selected media route was not TURN/${relayTransport.toUpperCase()}`,
        );
      return {
        candidateType: candidate.candidateType,
        relayProtocol: candidate.relayProtocol,
        videoBytesSent: bytes,
        dtlsState: transport.dtlsState,
        dtlsCipher: transport.dtlsCipher ?? null,
        srtpCipher: transport.srtpCipher ?? null,
      };
    }
  }
}
button.addEventListener("click", async () => {
  button.disabled = true;
  Object.assign(report, {
    result: "running",
    startedAt: new Date().toISOString(),
    stage: "host exchange",
  });
  render();
  let room, stream, interval;
  try {
    await api("/host", { token: hostToken });
    const grant = await api("/media");
    report.stage = `TURN/${relayTransport.toUpperCase()} connection`;
    render();
    const { Room, Track } = window.LivekitClient;
    room = new Room({ adaptiveStream: false, dynacast: false });
    await room.connect(grant.url, grant.token, {
      autoSubscribe: false,
      rtcConfig: { iceTransportPolicy: "relay" },
      peerConnectionTimeout: 20_000,
    });
    const canvas = document.querySelector("#video"),
      ctx = canvas.getContext("2d");
    let frame = 0;
    const draw = () => {
      ctx.fillStyle = `rgb(${++frame % 255},100,130)`;
      ctx.fillRect(0, 0, 160, 90);
    };
    draw();
    interval = setInterval(draw, 100);
    stream = canvas.captureStream(10);
    await room.localParticipant.publishTrack(stream.getVideoTracks()[0], {
      source: Track.Source.Camera,
      simulcast: false,
      videoEncoding: { maxBitrate: 100_000, maxFramerate: 10 },
    });
    report.stage = "selected route and RTP bytes";
    render();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !report.transport) {
      report.transport = await selectedRoute();
      if (!report.transport)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!report.transport)
      throw new Error(
        `No selected TURN/${relayTransport.toUpperCase()} route with outbound video bytes`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const next = await selectedRoute();
    if (!next || next.videoBytesSent <= report.transport.videoBytesSent)
      throw new Error("Video RTP bytes did not increase");
    report.transport = next;
    report.frames = frame;
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.failure = String(error.message ?? error)
      .replaceAll(hostToken, "[redacted]")
      .replace(
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "[redacted]",
      );
  } finally {
    clearInterval(interval);
    stream?.getTracks().forEach((track) => track.stop());
    await room?.disconnect().catch(() => {});
    for (const peer of peers) peer.close();
    try {
      await api("/end");
      report.meetingEnded = true;
    } catch {
      report.meetingEnded = false;
      report.result = "failed";
    }
    report.finishedAt = new Date().toISOString();
    delete report.stage;
    render();
  }
});
