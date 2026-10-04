import test from "node:test";
import assert from "node:assert/strict";
import { SipClient } from "./sip-client.mjs";

// This process tests the controller protocol only. Real SIP/media is validated
// separately against Asterisk; these counters are deliberately synthetic.
const child = String.raw`
  const { createInterface } = require('node:readline');
  let count = 0;
  const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  const stats = () => emit({event:'stats', connected:true, disconnected:false,
    status:200, tlsVerified:true, tlsAllowedProtocols:48, tlsCipher:4865,
    verificationErrors:0, srtpActive:true, srtpSuiteConfirmed:true,
    receivedFrames:++count, nonSilentFrames:count, peak:600,
    generatedFrames:count, rxPackets:count, txPackets:count,
    password:'synthetic-secret-must-not-be-retained'});
  process.stderr.write('synthetic-private-SIP-debug-must-not-be-retained\n');
  stats();
  createInterface({input:process.stdin}).on('line', (line) => {
    if (line === 'stats') stats();
    else if (line.startsWith('tone ')) emit({event:'command', operation:'tone', accepted:true});
    else if (line.startsWith('dtmf ')) {
      emit({event:'command', operation:'dtmf', accepted:true, digits:line.slice(5)});
      setTimeout(() => emit({event:'dtmf-drained'}), 10);
    } else if (line === 'hangup') { emit({event:'stopped'}); process.exit(0); }
  });
`;

test("fresh SIP stats cannot be satisfied by previously received counters", async (t) => {
  const client = new SipClient({
    command: process.execPath,
    args: ["-e", child],
  });
  t.after(() => client.close());
  const initial = await client.waitFor((event) => event.event === "stats");
  const [first, second] = await Promise.all([client.stats(), client.stats()]);
  assert(first.sequence > initial.sequence);
  assert(second.sequence > first.sequence);
  assert.equal(first.receivedFrames, initial.receivedFrames + 1);
  assert.equal(second.receivedFrames, first.receivedFrames + 1);
});

test("SIP controller keeps credentials, digits, and native stderr out of evidence", async (t) => {
  const client = new SipClient({
    command: process.execPath,
    args: ["-e", child],
  });
  t.after(() => client.close());
  await client.waitFor((event) => event.event === "stats");
  const digits = "918273645012#56473829#";
  await client.dtmf(digits);
  await client.tone(false);
  const evidence = JSON.stringify(client.events);
  assert(!evidence.includes(digits));
  assert(!evidence.includes("secret"));
  assert(!evidence.includes("private-SIP"));
  assert(!evidence.includes("password"));
  assert.throws(() => client.dtmf("bad\ninput"), /Invalid DTMF/);
  assert(client.events.some((event) => event.event === "dtmf-drained"));
});
