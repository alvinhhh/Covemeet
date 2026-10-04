import {
  LocalKeyProvider,
  RecordingIntegrityError,
  type KeyProvider,
  type KeyBinding,
  type WrappedKey,
} from "./index.js";

/** New writes use one active KEK; retained KEKs recover older envelopes/backups. */
export class LocalKeyringProvider implements KeyProvider {
  readonly activeKeyId: string;
  private readonly providers = new Map<string, LocalKeyProvider>();
  constructor(options: {
    activeKeyId: string;
    keys: Record<string, Uint8Array>;
  }) {
    if (
      !Object.hasOwn(options.keys, options.activeKeyId) ||
      Object.keys(options.keys).length > 64
    ) {
      throw new TypeError(
        "The active recording key must exist in a keyring of at most 64 keys",
      );
    }
    this.activeKeyId = options.activeKeyId;
    try {
      for (const [keyId, key] of Object.entries(options.keys)) {
        this.providers.set(keyId, new LocalKeyProvider({ keyId, key }));
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  async wrapKey(key: Uint8Array, binding: KeyBinding): Promise<WrappedKey> {
    const active = this.providers.get(this.activeKeyId);
    if (!active) throw new Error("Keyring has been destroyed");
    return active.wrapKey(key, binding);
  }
  async unwrapKey(
    wrapped: WrappedKey,
    binding: KeyBinding,
  ): Promise<Uint8Array> {
    const provider = this.providers.get(wrapped?.keyId);
    if (!provider) throw new RecordingIntegrityError();
    return provider.unwrapKey(wrapped, binding);
  }
  destroy(): void {
    for (const provider of this.providers.values()) provider.destroy();
    this.providers.clear();
  }
}
