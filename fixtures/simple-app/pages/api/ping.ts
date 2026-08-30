export default function handler(req: unknown, res: { json: (body: unknown) => void }) {
  res.json({ ok: true });
}
