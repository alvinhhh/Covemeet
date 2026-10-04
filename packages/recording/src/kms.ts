import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import {
  RecordingIntegrityError,
  type KeyProvider,
  type KeyBinding,
  type WrappedKey,
} from "./index.js";

const PROVIDER = "aws-kms-symmetric-v1";
const KEY_ARN =
  /^arn:aws(?:-us-gov|-cn)?:kms:[a-z0-9-]+:\d{12}:key\/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$/;

function encryptionContext(binding: KeyBinding): Record<string, string> {
  if (!/^[a-f0-9]{32}$/.test(binding.recordingKeyId))
    throw new RecordingIntegrityError();
  for (const value of [
    binding.context?.tenantId,
    binding.context?.meetingId,
    binding.context?.recordingId,
  ]) {
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024)
      throw new RecordingIntegrityError();
  }
  return {
    purpose: "covemeet-recording-dek-v1",
    tenant: binding.context.tenantId,
    meeting: binding.context.meetingId,
    recording: binding.context.recordingId,
    recordingKey: binding.recordingKeyId,
  };
}

/** Uses workload identity/default AWS credential chain; never receives cloud secrets in metadata. */
export class AwsKmsKeyProvider implements KeyProvider {
  private readonly client: Pick<KMSClient, "send">;
  private readonly allowed: Set<string>;
  readonly activeKeyId: string;
  constructor(options: {
    region: string;
    activeKeyId: string;
    decryptKeyIds?: string[];
    client?: Pick<KMSClient, "send">;
  }) {
    this.allowed = new Set([
      options.activeKeyId,
      ...(options.decryptKeyIds ?? []),
    ]);
    if (
      !/^[a-z0-9-]{3,32}$/.test(options.region) ||
      this.allowed.size > 64 ||
      [...this.allowed].some((key) => !KEY_ARN.test(key))
    ) {
      throw new TypeError(
        "KMS requires a region and immutable key ARNs (aliases are not permitted)",
      );
    }
    this.activeKeyId = options.activeKeyId;
    this.client =
      options.client ??
      new KMSClient({ region: options.region, maxAttempts: 3 });
  }
  async wrapKey(key: Uint8Array, binding: KeyBinding): Promise<WrappedKey> {
    if (key.byteLength !== 32)
      throw new TypeError("Recording data keys must be 32 bytes");
    const owned = Buffer.from(key);
    try {
      const response = await this.client.send(
        new EncryptCommand({
          KeyId: this.activeKeyId,
          Plaintext: owned,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          EncryptionContext: encryptionContext(binding),
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      if (
        !response.CiphertextBlob?.length ||
        response.CiphertextBlob.length > 6144 ||
        response.KeyId !== this.activeKeyId ||
        response.EncryptionAlgorithm !== "SYMMETRIC_DEFAULT"
      ) {
        throw new RecordingIntegrityError();
      }
      return {
        provider: PROVIDER,
        keyId: response.KeyId,
        ciphertext: Buffer.from(response.CiphertextBlob).toString("base64"),
      };
    } finally {
      owned.fill(0);
    }
  }
  async unwrapKey(
    wrapped: WrappedKey,
    binding: KeyBinding,
  ): Promise<Uint8Array> {
    if (
      wrapped?.provider !== PROVIDER ||
      !this.allowed.has(wrapped.keyId) ||
      typeof wrapped.ciphertext !== "string" ||
      wrapped.ciphertext.length > 8192
    )
      throw new RecordingIntegrityError();
    const ciphertext = Buffer.from(wrapped.ciphertext, "base64");
    if (
      !ciphertext.length ||
      ciphertext.toString("base64") !== wrapped.ciphertext
    )
      throw new RecordingIntegrityError();
    let plaintext: Uint8Array | undefined;
    try {
      const response = await this.client.send(
        new DecryptCommand({
          KeyId: wrapped.keyId,
          CiphertextBlob: ciphertext,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          EncryptionContext: encryptionContext(binding),
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      plaintext = response.Plaintext;
      if (
        plaintext?.byteLength !== 32 ||
        response.KeyId !== wrapped.keyId ||
        response.EncryptionAlgorithm !== "SYMMETRIC_DEFAULT"
      )
        throw new RecordingIntegrityError();
      return Buffer.from(plaintext);
    } catch {
      throw new RecordingIntegrityError();
    } finally {
      plaintext?.fill(0);
    }
  }
}
