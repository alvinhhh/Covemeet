package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
)

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
	if decode([]byte(`{"type":"snapshot","id":1,"token":"private"}`), &c) == nil || decode([]byte(`{"type":"snapshot","id":1} {}`), &c) == nil {
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
	if joinBudget(2) != 15*time.Second || joinBudget(82) != 75*time.Second || joinBudget(982) != 90*time.Second {
		t.Fatal("connection budget escaped bounded profile")
	}
}
