const PATTERNS = [
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /\bsk-[A-Za-z0-9._\-]{8,}\b/g,
  /(api[_-]?key\s*[=:]\s*)[^\s,&]+/gi,
];
export function redact(s: string): string {
  let out = s;
  for (const p of PATTERNS) {
    // 有捕获组（api_key= 前缀）→ 保留前缀只遮蔽值；无捕获组 → 整段遮蔽
    out = out.replace(p, (_m, g1?: string) => (g1 !== undefined ? `${g1}***` : '***'));
  }
  return out;
}
