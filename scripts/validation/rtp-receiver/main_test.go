package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
)

func TestReceiverShutdownDuringJoin(t *testing.T) {
	for _, reason := range []string{"stop", "invalid-grant", "deadline"} {
		t.Run(reason, func(t *testing.T) {
			ctx, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			input, send := io.Pipe()
			output, receive := io.Pipe()
			defer input.Close()
			defer send.Close()
			defer output.Close()
			defer receive.Close()
			result := make(chan int, 1)
			go func() {
				result <- run(ctx, input, receive)
				receive.Close()
			}()
			c := config{Profile: "webinar"}
			for i := 0; i < webinarStage; i++ {
				c.Publishers = append(c.Publishers, fmt.Sprintf("stage-%d", i))
			}
			for i := 0; i < webinarViewers; i++ {
				c.Peers = append(c.Peers, peerInput{Index: firstPeer + i, URL: "ws://127.0.0.1:65535"})
			}
			if err := json.NewEncoder(send).Encode(c); err != nil {
				t.Fatal(err)
			}
			requested, closed := false, false
			fault := ""
			scanner := bufio.NewScanner(output)
			for scanner.Scan() {
				var message struct {
					Type        string `json:"type"`
					Index       int    `json:"index"`
					PeersClosed bool   `json:"peersClosed"`
					Failure     string `json:"failure"`
				}
				if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
					t.Fatal(err)
				}
				if message.Type == "grant-request" && !requested {
					requested = true
					switch reason {
					case "stop":
						fmt.Fprintln(send, `{"type":"stop","id":1}`)
					case "invalid-grant":
						fmt.Fprintf(send, "{\"type\":\"grant\",\"index\":%d,\"token\":\"invalid\"}\n", message.Index)
					case "deadline":
						cancel(context.DeadlineExceeded)
					}
				}
				if message.Type == "finished" {
					closed = message.PeersClosed
				}
				if message.Type == "fault" {
					fault = message.Failure
				}
			}
			want := 1
			if reason == "stop" {
				want = 0
			}
			if code := <-result; code != want || !requested || !closed || scanner.Err() != nil {
				t.Fatalf("exit=%d want=%d requested=%t closed=%t read=%v", code, want, requested, closed, scanner.Err())
			}
			if reason == "invalid-grant" && fault != "receiver-invalid-grant" || reason != "invalid-grant" && fault != "" {
				t.Fatalf("unexpected fault: %q", fault)
			}
		})
	}
}

func TestCompleteFrameCounters(t *testing.T) {
	s := &stream{}
	packet := func(sequence uint16) *rtp.Packet {
		return &rtp.Packet{Header: rtp.Header{SequenceNumber: sequence}, Payload: []byte{1, 2}}
	}
	if !s.add([]*rtp.Packet{packet(65535)}) || !s.add([]*rtp.Packet{packet(0), packet(2)}) || s.Packets != 3 || s.Frames != 2 || s.Bytes != 6 || s.UnusablePacketGaps != 1 {
		t.Fatal("wraparound and missing-packet accounting")
	}
	if s.add([]*rtp.Packet{packet(2)}) || s.add([]*rtp.Packet{packet(1)}) {
		t.Fatal("duplicate or backward sequence accepted")
	}
	var c command
	if decode([]byte(`{"type":"snapshot","id":1,"secret":"private"}`), &c) == nil || decode([]byte(`{"type":"snapshot","id":1} {}`), &c) == nil {
		t.Fatal("protocol accepted extra fields or trailing JSON")
	}
}

func TestReceiverProfiles(t *testing.T) {
	fixture := func(count int) config {
		c := config{Publishers: []string{"p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"}}
		for i := 0; i < count; i++ {
			claims := fmt.Sprintf(`{"sub":"receiver-%d","exp":%d,"video":{"room":"profile","roomJoin":true,"canSubscribe":true}}`, i, time.Now().Unix()+120)
			token := "e30." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + "."
			token += strings.Repeat("x", maxTokenBytes-len(token))
			c.Peers = append(c.Peers, peerInput{Index: firstPeer + i, URL: "ws://127.0.0.1:65535", Token: token})
		}
		return c
	}
	for _, count := range []int{2, 82, 982} {
		c := fixture(count)
		encoded, err := json.Marshal(c)
		if err != nil || len(encoded) > maxConfigBytes || !validate(c) {
			t.Fatalf("%d-peer maximum JWT input rejected", count)
		}
		var decoded config
		if decode(encoded, &decoded) != nil || !validate(decoded) {
			t.Fatalf("%d-peer input round trip rejected", count)
		}
		c.Peers[len(c.Peers)-1].Index++
		if validate(c) {
			t.Fatal("noncontiguous indices accepted")
		}
	}
	for _, count := range []int{1, 983} {
		if validate(fixture(count)) {
			t.Fatal("out-of-bounds profile accepted")
		}
	}
	c := fixture(2)
	c.Peers[1].Token = c.Peers[0].Token
	if validate(c) {
		t.Fatal("duplicate participant identity accepted")
	}
	if joinBudget(2, "") != 15*time.Second || joinBudget(82, "") != 75*time.Second || joinBudget(982, "") != 90*time.Second || joinBudget(webinarViewers, "webinar") != 180*time.Second {
		t.Fatal("connection budget escaped bounded profile")
	}
	if cleanupBudget("") != 7*time.Second || cleanupBudget("webinar") != 45*time.Second {
		t.Fatal("cleanup budget escaped bounded profile")
	}
	webinar := config{Profile: "webinar"}
	for i := 0; i < webinarStage; i++ {
		webinar.Publishers = append(webinar.Publishers, fmt.Sprintf("stage-%d", i))
	}
	for i := 0; i < webinarViewers; i++ {
		webinar.Peers = append(webinar.Peers, peerInput{Index: firstPeer + i, URL: "ws://127.0.0.1:65535"})
	}
	encoded, err := json.Marshal(webinar)
	if err != nil || len(encoded) > maxConfigBytes || !validate(webinar) {
		t.Fatal("complete hidden webinar profile rejected")
	}
	var restored config
	if decode(encoded, &restored) != nil || !validate(restored) {
		t.Fatal("complete hidden webinar input round trip rejected")
	}
	webinar.Peers = webinar.Peers[:webinarViewers-1]
	if validate(webinar) {
		t.Fatal("incomplete webinar audience accepted")
	}
	webinar.Peers = restored.Peers
	webinar.Publishers = webinar.Publishers[:webinarStage-1]
	if validate(webinar) {
		t.Fatal("incomplete webinar stage accepted")
	}
	webinar.Publishers = restored.Publishers
	webinar.Peers = append([]peerInput(nil), restored.Peers...)
	webinar.Peers[0].Token = "preissued"
	if validate(webinar) {
		t.Fatal("preissued webinar credential accepted")
	}
}

func webinarToken(sub, room string, exp int64) string {
	claims := fmt.Sprintf(`{"sub":%q,"exp":%d,"video":{"room":%q,"roomJoin":true,"canSubscribe":true,"canPublish":false,"canPublishData":false,"hidden":true}}`, sub, exp, room)
	return "e30." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + ".signature"
}

func mutateGrant(t *testing.T, token, old, next string) string {
	t.Helper()
	parts := strings.Split(token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !strings.Contains(string(payload), old) {
		t.Fatal("invalid grant fixture")
	}
	parts[1] = base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(payload), old, next, 1)))
	return strings.Join(parts, ".")
}

func TestWebinarGrantProtocol(t *testing.T) {
	token := webinarToken("viewer-0", "webinar", time.Now().Unix()+120)
	if sub, room, ok := webinarClaims(token); !ok || sub != "viewer-0" || room != "webinar" {
		t.Fatal("valid hidden subscriber grant rejected")
	}
	g := &grantProtocol{waiters: map[int]chan string{}, seen: map[string]bool{"stage-0": true}}
	waiter := g.expect(firstPeer)
	if g.accept(firstPeer+1, token) || !g.accept(firstPeer, token) || <-waiter != token || g.accept(firstPeer, token) {
		t.Fatal("grant was not confined to its requested join slot")
	}
	g.expect(firstPeer + 1)
	if g.accept(firstPeer+1, token) || g.accept(firstPeer+1, webinarToken("viewer-1", "other-room", time.Now().Unix()+120)) || g.accept(firstPeer+1, webinarToken("stage-0", "webinar", time.Now().Unix()+120)) {
		t.Fatal("duplicate identity, room drift, or stage identity accepted")
	}
	if !g.accept(firstPeer+1, webinarToken("viewer-1", "webinar", time.Now().Unix()+120)) {
		t.Fatal("second valid grant rejected")
	}
	for _, invalid := range []string{
		webinarToken("viewer-2", "webinar", time.Now().Unix()+15),
		webinarToken("viewer-2", "webinar", time.Now().Unix()+3600),
		mutateGrant(t, token, `"hidden":true`, `"hidden":false`),
		mutateGrant(t, token, `"canPublish":false`, `"canPublish":true`),
		mutateGrant(t, token, `"canPublishData":false`, `"canPublishData":true`),
		mutateGrant(t, token, `"canSubscribe":true`, `"canSubscribe":false`),
		mutateGrant(t, token, `"roomJoin":true`, `"roomJoin":false`),
		"bad.jwt",
		strings.Repeat("x", maxTokenBytes+1),
	} {
		if _, _, ok := webinarClaims(invalid); ok {
			t.Fatal("invalid webinar grant accepted")
		}
	}
}

func TestWebinarStreamKinds(t *testing.T) {
	meeting, webinar := stream{Publisher: 1}, stream{Publisher: 1, Kind: "audio"}
	for _, check := range []struct {
		value stream
		want  string
	}{
		{meeting, `{"publisher":1,"bytes":0,"packets":0,"frames":0,"unusablePacketGaps":0}`},
		{webinar, `{"publisher":1,"kind":"audio","bytes":0,"packets":0,"frames":0,"unusablePacketGaps":0}`},
	} {
		data, err := json.Marshal(check.value)
		if err != nil || string(data) != check.want {
			t.Fatalf("track row schema: %s, %v", data, err)
		}
	}
	streams := map[streamKey]*stream{}
	for publisher := 0; publisher < webinarStage; publisher++ {
		for _, kind := range []string{"audio", "video"} {
			key := streamKey{publisher: publisher, kind: kind}
			streams[key] = &stream{Publisher: publisher, Kind: kind}
		}
	}
	if len(streams) != 20 || streams[streamKey{publisher: 0, kind: "audio"}] == streams[streamKey{publisher: 0, kind: "video"}] {
		t.Fatal("audio and video tracks did not remain independent")
	}
}
