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

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

type peerInput struct {
	Index int    `json:"index"`
	URL   string `json:"url"`
	Token string `json:"token"`
}
type config struct {
	Peers      []peerInput `json:"peers"`
	Publishers []string    `json:"publishers"`
}

const (
	firstPeer      = 18
	maxPeers       = 982
	publisherCount = 9
	maxTokenBytes  = 8192
	// 982 JWTs plus peer fields and nine publisher identities fit below 8 MiB.
	maxConfigBytes = 8 << 20
	parallelJoins  = 20
)

func joinBudget(count int) time.Duration {
	return min(time.Duration((count+parallelJoins-1)/parallelJoins)*15*time.Second, 90*time.Second)
}

type command struct {
	Type string `json:"type"`
	ID   int    `json:"id"`
}
type stream struct {
	Publisher          int    `json:"publisher"`
	Bytes              uint64 `json:"bytes"`
	Packets            uint64 `json:"packets"`
	Frames             uint64 `json:"frames"`
	UnusablePacketGaps uint64 `json:"unusablePacketGaps"`
	last               uint16
	started            bool
	publication        *lksdk.RemoteTrackPublication
}
type peer struct {
	index            int
	room             *lksdk.Room
	mu               sync.Mutex
	streams          map[int]*stream
	wirePayloadBytes uint64
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
	if len(c.Peers) < 2 || len(c.Peers) > maxPeers || len(c.Publishers) != publisherCount {
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
		if err != nil || port < 1 || port > 65535 || len(p.Token) > maxTokenBytes {
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
				Room      string `json:"room"`
				Join      bool   `json:"roomJoin"`
				Subscribe bool   `json:"canSubscribe"`
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

func run() int {
	if runtime.GOOS != "linux" || len(os.Args) != 1 {
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ctx, deadline := context.WithTimeout(ctx, 260*time.Second)
	defer deadline()
	var outputMu sync.Mutex
	emit := func(value any) {
		outputMu.Lock()
		defer outputMu.Unlock()
		if json.NewEncoder(os.Stdout).Encode(value) != nil {
			cancel()
		}
	}
	fault := func(label string) {
		if ctx.Err() == nil {
			emit(map[string]any{"type": "fault", "failure": label})
			cancel()
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), maxConfigBytes+1)
	var c config
	if !scanner.Scan() || len(scanner.Bytes()) > maxConfigBytes || decode(scanner.Bytes(), &c) != nil || !validate(c) {
		emit(map[string]any{"type": "fault", "failure": "receiver-input"})
		return 1
	}
	commands := make(chan command)
	go func() {
		defer cancel()
		for scanner.Scan() {
			var cmd command
			if len(scanner.Bytes()) > 128 || decode(scanner.Bytes(), &cmd) != nil || (cmd.Type != "snapshot" && cmd.Type != "stop") || cmd.ID < 1 {
				fault("receiver-command")
				return
			}
			if cmd.Type == "stop" {
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
		for _, p := range peers {
			if p != nil && p.room != nil {
				p.room.Disconnect()
			}
		}
		readers.Wait()
		emit(map[string]any{"type": "finished", "peersClosed": true})
	}()
	for i, input := range c.Peers {
		p := &peer{index: input.Index, streams: map[int]*stream{}}
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
					if publisher < 0 || track.Kind() != webrtc.RTPCodecTypeVideo {
						fault("receiver-unexpected-source")
						return
					}
					var depacketizer rtp.Depacketizer
					switch strings.ToLower(track.Codec().MimeType) {
					case "video/vp8":
						depacketizer = &codecs.VP8Packet{}
					case "video/h264":
						depacketizer = &codecs.H264Packet{}
					default:
						fault("receiver-codec")
						return
					}
					s := &stream{Publisher: publisher, publication: pub}
					p.mu.Lock()
					if p.streams[publisher] != nil {
						p.mu.Unlock()
						fault("receiver-duplicate-source")
						return
					}
					p.streams[publisher] = s
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
						rp.WritePLI(track.SSRC())
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
	}
	var joins sync.WaitGroup
	slots := make(chan struct{}, parallelJoins)
	joinTimer := time.AfterFunc(joinBudget(len(peers)), func() { fault("receiver-connect-timeout") })
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
			if p.room.JoinWithContextAndToken(ctx, c.Peers[i].URL, c.Peers[i].Token, lksdk.WithConnectTimeout(15*time.Second)) != nil {
				fault("receiver-connect-failed")
			}
		}()
	}
	joins.Wait()
	joinTimer.Stop()
	if ctx.Err() != nil {
		return 1
	}
	indices := make([]int, len(peers))
	for i, p := range peers {
		indices[i] = p.index
	}
	emit(map[string]any{"type": "connected", "indices": indices})
	for {
		select {
		case <-ctx.Done():
			return 0
		case cmd := <-commands:
			rows := []map[string]any{}
			for _, p := range peers {
				p.mu.Lock()
				streams := []stream{}
				var received, packets, frames, gaps uint64
				var secure map[string]any
				for _, s := range p.streams {
					streams = append(streams, *s)
					received += s.Bytes
					packets += s.Packets
					frames += s.Frames
					gaps += s.UnusablePacketGaps
					secure = transport(s.publication)
					if secure == nil || s.Packets == 0 {
						secure = nil
						break
					}
				}
				sort.Slice(streams, func(i, j int) bool { return streams[i].Publisher < streams[j].Publisher })
				rows = append(rows, map[string]any{"index": p.index, "streams": streams, "bytesReceived": received, "packetsReceived": packets, "receivedFrames": frames, "packetsLost": gaps, "lossMetric": "unusable-packet-gaps", "receivePayloadBytes": p.wirePayloadBytes, "subscriber": secure})
				p.mu.Unlock()
			}
			var usage syscall.Rusage
			if syscall.Getrusage(syscall.RUSAGE_SELF, &usage) != nil {
				fault("receiver-resources")
				continue
			}
			emit(map[string]any{"type": "snapshot", "id": cmd.ID, "rows": rows, "cpuMicros": int64(usage.Utime.Sec)*1000000 + int64(usage.Utime.Usec) + int64(usage.Stime.Sec)*1000000 + int64(usage.Stime.Usec), "rssBytes": usage.Maxrss * 1024})
		}
	}
}
func main() { os.Exit(run()) }
