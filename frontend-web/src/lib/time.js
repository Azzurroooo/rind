// Relative-time labels for the session rail (goose/crush pattern): a rail of
// raw ISO timestamps reads like a log file; "5 分钟前" reads like history.
export function relativeTime(value, now = Date.now()) {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return "";
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const pad = (part) => String(part).padStart(2, "0");
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  return sameYear ? md : `${date.getFullYear()}年${md}`;
}
