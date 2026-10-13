type Preview = {
  title: string;
  body: string;
  url: string;
  notificationId: string;
};
const MAX_BYTES = 3072;

/** Push is a small preview; the full authored title/body remain in the inbox. */
export function pushPreview(
  title: string,
  body: string,
  href: string | null,
  notificationId: string,
) {
  const fallback = `/notifications?notification=${encodeURIComponent(notificationId)}`;
  const preview: Preview = {
    title: "",
    body: "",
    url: href ?? fallback,
    notificationId,
  };
  const fit = (text: string, accepts: (value: string) => boolean) => {
    const points = Array.from(text);
    let low = 0,
      high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (accepts(points.slice(0, middle).join(""))) low = middle;
      else high = middle - 1;
    }
    return points.slice(0, low).join("");
  };
  preview.title = fit(
    title,
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 512,
  );
  if (Buffer.byteLength(JSON.stringify(preview), "utf8") > MAX_BYTES)
    preview.url = fallback;
  preview.body = fit(
    body,
    (value) =>
      Buffer.byteLength(JSON.stringify({ ...preview, body: value }), "utf8") <=
      MAX_BYTES,
  );
  const payload = JSON.stringify(preview);
  if (Buffer.byteLength(payload, "utf8") > MAX_BYTES)
    throw new Error("Notification preview metadata exceeds the push budget");
  return payload;
}
