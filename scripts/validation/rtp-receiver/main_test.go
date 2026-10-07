package main

import (
	"testing"

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
