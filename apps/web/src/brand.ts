export function brandLogo(
  brandName: string,
  customLogo?: string,
): string | undefined {
  return (
    customLogo ||
    (brandName.trim().toLowerCase() === "covemeet"
      ? "/covemeet-logo.png"
      : undefined)
  );
}
