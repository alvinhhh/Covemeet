// The suffix is emitted by native SIP callee dispatch with randomize=true.
// Legacy isolated RTC fixtures have no suffix. Neither form can name a meeting.
export function isHoldingRoom(value: string): boolean {
  return /^phone-hold-[A-Za-z0-9-]{16,128}(?:_[A-Za-z0-9-]{8,64})?$/.test(
    value,
  );
}
