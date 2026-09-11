/** Scanner-only normalization. Keep original statements and evidence unchanged. */
export function normalizeRiskText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, "$1");
}
