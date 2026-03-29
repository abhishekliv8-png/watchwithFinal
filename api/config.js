export default async function handler(req, res) {
  res.json({
    appUrl: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://watchwith.vercel.app",
  });
}
