import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

for (const transport of ["tls", "udp"])
  test(`browser fixture preserves authenticated local ${transport} grants and rejects another route`, async () => {
    const stats = new Map([
      ["video", { type: "outbound-rtp", kind: "video", bytesSent: 100 }],
      [
        "transport",
        {
          type: "transport",
          dtlsState: "connected",
          selectedCandidatePairId: "pair",
        },
      ],
      ["pair", { localCandidateId: "candidate" }],
      ["candidate", { candidateType: "relay", relayProtocol: transport }],
    ]);
    class Peer {
      constructor(config) {
        this.config = config;
      }
      setConfiguration(config) {
        this.config = config;
      }
      addEventListener() {}
      async getStats() {
        return stats;
      }
    }
    const context = vm.createContext({
      URLSearchParams,
      console,
      location: {
        origin: "https://meet.localhost:8443",
        pathname: "/__validation/turn.html",
        hash: `#code=synthetic&host=synthetic&transport=${transport}`,
      },
      history: { replaceState() {} },
      document: { querySelector: () => ({ addEventListener() {} }) },
      window: { RTCPeerConnection: Peer },
    });
    vm.runInContext(
      await readFile(new URL("browser-turn.mjs", import.meta.url), "utf8"),
      context,
    );
    const supplied = {
      iceTransportPolicy: "all",
      iceServers: [
        {
          username: "synthetic-user",
          credential: "synthetic-secret",
          urls: [
            "turn:127.0.0.1:13478?transport=udp",
            "turns:meet.localhost:443?transport=tcp",
            "turns:untrusted.example:15349",
          ],
        },
      ],
    };
    const peer = new context.window.RTCPeerConnection(supplied);
    assert.equal(peer.config.iceTransportPolicy, "relay");
    assert.equal(
      peer.config.iceServers[0].urls.join(),
      transport === "tls"
        ? "turns:meet.localhost:15349?transport=tcp"
        : "turn:127.0.0.1:13478?transport=udp",
    );
    assert.equal(peer.config.iceServers[0].credential, "synthetic-secret");
    assert.equal(supplied.iceServers[0].urls.length, 3);
    peer.setConfiguration(supplied);
    assert.equal(peer.config.iceTransportPolicy, "relay");
    assert.equal((await context.selectedRoute()).relayProtocol, transport);
    stats.get("candidate").relayProtocol = transport === "tls" ? "udp" : "tls";
    await assert.rejects(context.selectedRoute(), /not TURN/);
    stats.get("candidate").relayProtocol = transport;
    stats.get("candidate").candidateType = "host";
    await assert.rejects(context.selectedRoute(), /not TURN/);
  });
