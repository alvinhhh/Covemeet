// Receive-only validation client. Credentials arrive through stdin, never arguments.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	protoLogger "github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

type peerInput struct {
	Index int    `json:"index"`
	URL   string `json:"url"`
	Token string `json:"token,omitempty"`
}
type config struct {
	Profile    string      `json:"profile,omitempty"`
	Peers      []peerInput `json:"peers"`
	Publishers []string    `json:"publishers"`
}

const (
	firstPeer      = 18
	maxPeers       = 982
	publisherCount = 9
	webinarViewers = 1000
	webinarStage   = 10
	maxTokenBytes  = 8192
	// Bound aggregate input as well as individual JWTs for either profile.
	maxConfigBytes = 8 << 20
	parallelJoins  = 20
)

func joinBudget(count int, profile string) time.Duration {
	if profile == "webinar" {
		return 180 * time.Second
	}
	return min(time.Duration((count+parallelJoins-1)/parallelJoins)*15*time.Second, 90*time.Second)
}

func cleanupBudget(profile string) time.Duration {
	if profile == "webinar" {
		return 45 * time.Second
	}
	return 7 * time.Second
}

type command struct {
	Type  string  `json:"type"`
	ID    *int    `json:"id,omitempty"`
	Index *int    `json:"index,omitempty"`
	Token *string `json:"token,omitempty"`
}
type stream struct {
	Publisher          int    `json:"publisher"`
	Kind               string `json:"kind,omitempty"`
	Bytes              uint64 `json:"bytes"`
	Packets            uint64 `json:"packets"`
	Frames             uint64 `json:"frames"`
	UnusablePacketGaps uint64 `json:"unusablePacketGaps"`
	last               uint16
	started            bool
	publication        *lksdk.RemoteTrackPublication
}
type streamKey struct {
	publisher int
	kind      string
}
type peer struct {
	index            int
	room             *lksdk.Room
	mu               sync.Mutex
	streams          map[streamKey]*stream
	wirePayloadBytes uint64
}

type grantProtocol struct {
	mu      sync.Mutex
	waiters map[int]chan string
	seen    map[string]bool
	room    string
}

func (g *grantProtocol) expect(index int) <-chan string {
	g.mu.Lock()
	defer g.mu.Unlock()
	ch := make(chan string, 1)
	g.waiters[index] = ch
	return ch
}

func (g *grantProtocol) accept(index int, token string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	waiter := g.waiters[index]
	if waiter == nil {
		return false
	}
	sub, room, ok := webinarClaims(token)
	if !ok || g.seen[sub] || (g.room != "" && g.room != room) {
		return false
	}
	delete(g.waiters, index)
	g.seen[sub] = true
	g.room = room
	waiter <- token
	return true
}

// Count packets from complete, reordered frames. Gaps conservatively include
// received packets in discarded frames; this is not a network-loss estimate.
func (s *stream) add(frame []*rtp.Packet) bool {
	if len(frame) == 0 {
		return true
	}
	for _, packet := range frame {
		if s.started {
			delta := uint16(packet.SequenceNumber - s.last)
			if delta == 0 || delta >= 0x8000 {
				return false
			}
			s.UnusablePacketGaps += uint64(delta - 1)
		}
		s.last, s.started = packet.SequenceNumber, true
		s.Bytes += uint64(len(packet.Payload))
		s.Packets++
	}
	s.Frames++
	return true
}

func decode(line []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(line))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing-json")
	}
	return nil
}
func validate(c config) bool {
	publishers := publisherCount
	switch c.Profile {
	case "":
		if len(c.Peers) < 2 || len(c.Peers) > maxPeers {
			return false
		}
	case "webinar":
		publishers = webinarStage
		if len(c.Peers) != webinarViewers {
			return false
		}
	default:
		return false
	}
	if len(c.Publishers) != publishers {
		return false
	}
	seen := map[string]bool{}
	for _, identity := range c.Publishers {
		if identity == "" || len(identity) > 256 || seen[identity] {
			return false
		}
		seen[identity] = true
	}
	room := ""
	for i, p := range c.Peers {
		u, err := url.Parse(p.URL)
		if err != nil || p.Index != firstPeer+i || u.Scheme != "ws" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return false
		}
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return false
		}
		if c.Profile == "webinar" {
			if p.Token != "" {
				return false
			}
			continue
		}
		if len(p.Token) > maxTokenBytes {
			return false
		}
		parts := strings.Split(p.Token, ".")
		if len(parts) != 3 {
			return false
		}
		data, err := base64.RawURLEncoding.DecodeString(parts[1])
		var claims struct {
			Sub   string `json:"sub"`
			Exp   int64  `json:"exp"`
			Video struct {
				Room        string `json:"room"`
				Join        bool   `json:"roomJoin"`
				Subscribe   bool   `json:"canSubscribe"`
				Publish     *bool  `json:"canPublish"`
				PublishData *bool  `json:"canPublishData"`
				Hidden      *bool  `json:"hidden"`
			} `json:"video"`
		}
		if err != nil || json.Unmarshal(data, &claims) != nil || claims.Sub == "" || seen[claims.Sub] || claims.Exp <= time.Now().Unix() || claims.Exp > time.Now().Unix()+180 || !claims.Video.Join || !claims.Video.Subscribe || claims.Video.Room == "" {
			return false
		}
		seen[claims.Sub] = true
		if room != "" && room != claims.Video.Room {
			return false
		}
		room = claims.Video.Room
	}
	return true
}

func webinarClaims(token string) (string, string, bool) {
	// The SFU verifies the signature when the grant is used to join.
	if len(token) == 0 || len(token) > maxTokenBytes {
		return "", "", false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", "", false
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", "", false
	}
	var claims struct {
		Sub   string `json:"sub"`
		Exp   int64  `json:"exp"`
		Video struct {
			Room        string `json:"room"`
			Join        bool   `json:"roomJoin"`
			Subscribe   bool   `json:"canSubscribe"`
			Publish     *bool  `json:"canPublish"`
			PublishData *bool  `json:"canPublishData"`
			Hidden      *bool  `json:"hidden"`
		} `json:"video"`
	}
	if json.Unmarshal(data, &claims) != nil || claims.Sub == "" || claims.Video.Room == "" || claims.Exp <= time.Now().Add(15*time.Second).Unix() || claims.Exp > time.Now().Add(180*time.Second).Unix() || !claims.Video.Join || !claims.Video.Subscribe || claims.Video.Hidden == nil || !*claims.Video.Hidden || claims.Video.Publish == nil || *claims.Video.Publish || claims.Video.PublishData == nil || *claims.Video.PublishData {
		return "", "", false
	}
	return claims.Sub, claims.Video.Room, true
}

func transport(pub *lksdk.RemoteTrackPublication) map[string]any {
	r := pub.Receiver()
	if r == nil || r.Transport() == nil {
		return nil
	}
	dtls := r.Transport()
	if dtls.State() != webrtc.DTLSTransportStateConnected || len(dtls.GetRemoteCertificate()) == 0 || dtls.ICETransport() == nil {
		return nil
	}
	pair, err := dtls.ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil {
		return nil
	}
	return map[string]any{"dtlsConnected": true, "remoteCertificatePresent": true, "candidateType": pair.Local.Typ.String(), "protocol": pair.Local.Protocol.String(), "srtpAuthenticated": true, "srtpEvidence": "pion-srtp-read", "dtlsCipher": nil, "srtpCipher": nil}
}

var errRequestedStop = errors.New("receiver-stop-requested")

func run(parent context.Context, input io.Reader, output io.Writer) int {
	ctx, cancelWithCause := context.WithCancelCause(parent)
	cancel := func() { cancelWithCause(nil) }
	defer cancel()
	var outputMu sync.Mutex
	emit := func(value any) {
		outputMu.Lock()
		defer outputMu.Unlock()
		if json.NewEncoder(output).Encode(value) != nil {
			cancel()
		}
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), maxConfigBytes+1)
	var c config
	if !scanner.Scan() || len(scanner.Bytes()) > maxConfigBytes || decode(scanner.Bytes(), &c) != nil || !validate(c) {
		emit(map[string]any{"type": "fault", "failure": "receiver-input"})
		return 1
	}
	runLimit := 260 * time.Second
	if c.Profile == "webinar" {
		runLimit = 450 * time.Second
	}
	ctx, deadline := context.WithTimeout(ctx, runLimit)
	defer deadline()
	exitCode := func() int {
		if errors.Is(context.Cause(ctx), errRequestedStop) {
			return 0
		}
		return 1
	}
	var faultOnce sync.Once
	fault := func(label string) {
		faultOnce.Do(func() {
			if ctx.Err() == nil {
				emit(map[string]any{"type": "fault", "failure": label})
				cancel()
			}
		})
	}
	commands := make(chan command, 16)
	grants := &grantProtocol{waiters: map[int]chan string{}, seen: map[string]bool{}}
	for _, publisher := range c.Publishers {
		grants.seen[publisher] = true
	}
	go func() {
		defer cancel()
		for scanner.Scan() {
			var cmd command
			err := decode(scanner.Bytes(), &cmd)
			var fields map[string]json.RawMessage
			if err == nil {
				err = decode(scanner.Bytes(), &fields)
			}
			if c.Profile == "webinar" && cmd.Type == "grant" {
				if err != nil || len(scanner.Bytes()) > maxTokenBytes+128 || len(fields) != 3 || cmd.ID != nil || cmd.Index == nil || cmd.Token == nil || !grants.accept(*cmd.Index, *cmd.Token) {
					fault("receiver-invalid-grant")
					return
				}
				continue
			}
			if err != nil || len(scanner.Bytes()) > 128 || len(fields) != 2 || (cmd.Type != "snapshot" && cmd.Type != "stop") || cmd.ID == nil || *cmd.ID < 1 || cmd.Index != nil || cmd.Token != nil {
				fault("receiver-command")
				return
			}
			if cmd.Type == "stop" {
				cancelWithCause(errRequestedStop)
				return
			}
			select {
			case commands <- cmd:
			case <-ctx.Done():
				return
			}
		}
	}()
	peers := make([]*peer, len(c.Peers))
	var readers sync.WaitGroup
	var readerGate sync.Mutex
	defer func() {
		readerGate.Lock()
		cancel()
		readerGate.Unlock()
		closed := make(chan struct{})
		go func() {
			var disconnects sync.WaitGroup
			slots := make(chan struct{}, parallelJoins)
			for _, p := range peers {
				if p == nil || p.room == nil {
					continue
				}
				slots <- struct{}{}
				disconnects.Add(1)
				go func() {
					defer disconnects.Done()
					defer func() { <-slots }()
					p.room.Disconnect()
				}()
			}
			disconnects.Wait()
			readers.Wait()
			close(closed)
		}()
		select {
		case <-closed:
			emit(map[string]any{"type": "finished", "peersClosed": true})
		case <-time.After(cleanupBudget(c.Profile)):
			emit(map[string]any{"type": "finished", "peersClosed": false})
		}
	}()
	for i, input := range c.Peers {
		p := &peer{index: input.Index, streams: map[streamKey]*stream{}}
		peers[i] = p
		p.room = lksdk.NewRoom(&lksdk.RoomCallback{
			OnDisconnected: func() { fault("receiver-disconnected") },
			OnReconnecting: func() { fault("receiver-reconnecting") },
			ParticipantCallback: lksdk.ParticipantCallback{
				OnTrackSubscriptionFailed: func(string, *lksdk.RemoteParticipant) { fault("receiver-subscription-failed") },
				OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
					publisher := -1
					for n, id := range c.Publishers {
						if id == rp.Identity() {
							publisher = n
						}
					}
					if publisher < 0 {
						fault("receiver-unexpected-source")
						return
					}
					kind := "video"
					if track.Kind() == webrtc.RTPCodecTypeAudio && c.Profile == "webinar" {
						kind = "audio"
					} else if track.Kind() != webrtc.RTPCodecTypeVideo {
						fault("receiver-unexpected-source")
						return
					}
					var depacketizer rtp.Depacketizer
					switch strings.ToLower(track.Codec().MimeType) {
					case "video/vp8":
						if kind == "video" {
							depacketizer = &codecs.VP8Packet{}
						}
					case "video/h264":
						if kind == "video" {
							depacketizer = &codecs.H264Packet{}
						}
					case "audio/opus":
						if kind == "audio" {
							depacketizer = &codecs.OpusPacket{}
						}
					}
					if depacketizer == nil {
						fault("receiver-codec")
						return
					}
					s := &stream{Publisher: publisher, publication: pub}
					if c.Profile == "webinar" {
						s.Kind = kind
					}
					key := streamKey{publisher: publisher, kind: kind}
					p.mu.Lock()
					if p.streams[key] != nil {
						p.mu.Unlock()
						fault("receiver-duplicate-source")
						return
					}
					p.streams[key] = s
					p.mu.Unlock()
					readerGate.Lock()
					if ctx.Err() != nil {
						readerGate.Unlock()
						return
					}
					readers.Add(1)
					readerGate.Unlock()
					go func() {
						defer readers.Done()
						builder := samplebuilder.New(100, depacketizer, track.Codec().ClockRate)
						if kind == "video" {
							rp.WritePLI(track.SSRC())
						}
						for ctx.Err() == nil {
							if track.SetReadDeadline(time.Now().Add(5*time.Second)) != nil {
								fault("receiver-read-deadline")
								return
							}
							packet, _, err := track.ReadRTP()
							if err != nil {
								fault("receiver-rtp-stopped")
								return
							}
							if packet == nil {
								continue
							}
							p.mu.Lock()
							p.wirePayloadBytes += uint64(len(packet.Payload))
							builder.Push(packet)
							valid := true
							for frame := builder.PopPackets(); len(frame) > 0; frame = builder.PopPackets() {
								valid = s.add(frame) && valid
							}
							p.mu.Unlock()
							if !valid {
								fault("receiver-sequence-discontinuity")
								return
							}
						}
					}()
				},
			},
		})
		p.room.SetLogger(protoLogger.GetDiscardLogger())
	}
	var joins sync.WaitGroup
	slots := make(chan struct{}, parallelJoins)
	joinTimer := time.AfterFunc(joinBudget(len(peers), c.Profile), func() { fault("receiver-connect-timeout") })
joinLoop:
	for i, p := range peers {
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			break joinLoop
		}
		joins.Add(1)
		go func() {
			defer joins.Done()
			defer func() { <-slots }()
			token := c.Peers[i].Token
			if c.Profile == "webinar" {
				grant := grants.expect(p.index)
				emit(map[string]any{"type": "grant-request", "index": p.index})
				timer := time.NewTimer(15 * time.Second)
				defer timer.Stop()
				select {
				case token = <-grant:
				case <-timer.C:
					fault("receiver-grant-timeout")
					return
				case <-ctx.Done():
					return
				}
			}
			if ctx.Err() != nil {
				return
			}
			if p.room.JoinWithContextAndToken(ctx, c.Peers[i].URL, token, lksdk.WithConnectTimeout(15*time.Second)) != nil {
				fault("receiver-connect-failed")
			}
		}()
	}
	joins.Wait()
	joinTimer.Stop()
	if ctx.Err() != nil {
		return exitCode()
	}
	indices := make([]int, len(peers))
	for i, p := range peers {
		indices[i] = p.index
	}
	emit(map[string]any{"type": "connected", "indices": indices})
	for {
		select {
		case <-ctx.Done():
			return exitCode()
		case cmd := <-commands:
			rows := []map[string]any{}
			for _, p := range peers {
				p.mu.Lock()
				streams := []stream{}
				var received, packets, frames, gaps uint64
				var secure map[string]any
				allSecure := len(p.streams) > 0
				for _, s := range p.streams {
					streams = append(streams, *s)
					received += s.Bytes
					packets += s.Packets
					frames += s.Frames
					gaps += s.UnusablePacketGaps
					evidence := transport(s.publication)
					if evidence == nil || s.Packets == 0 {
						allSecure = false
					} else if secure == nil {
						secure = evidence
					}
				}
				if !allSecure {
					secure = nil
				}
				sort.Slice(streams, func(i, j int) bool {
					if streams[i].Publisher == streams[j].Publisher {
						return streams[i].Kind < streams[j].Kind
					}
					return streams[i].Publisher < streams[j].Publisher
				})
				rows = append(rows, map[string]any{"index": p.index, "streams": streams, "bytesReceived": received, "packetsReceived": packets, "receivedFrames": frames, "packetsLost": gaps, "lossMetric": "unusable-packet-gaps", "receivePayloadBytes": p.wirePayloadBytes, "subscriber": secure})
				p.mu.Unlock()
			}
			var usage syscall.Rusage
			if syscall.Getrusage(syscall.RUSAGE_SELF, &usage) != nil {
				fault("receiver-resources")
				continue
			}
			emit(map[string]any{"type": "snapshot", "id": *cmd.ID, "rows": rows, "cpuMicros": int64(usage.Utime.Sec)*1000000 + int64(usage.Utime.Usec) + int64(usage.Stime.Sec)*1000000 + int64(usage.Stime.Usec), "rssBytes": usage.Maxrss * 1024})
		}
	}
}
func main() {
	if runtime.GOOS != "linux" || len(os.Args) != 1 {
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Stdin, os.Stdout)
	cancel()
	os.Exit(code)
}
