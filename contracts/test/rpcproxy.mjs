// Minimal JSON-RPC pass-through that adds a browser User-Agent, so forge's
// fork backend can reach an RPC sitting behind a Cloudflare challenge.
import http from "node:http";
const UPSTREAM = "https://rpc.mainnet.chain.robinhood.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const r = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA, Accept: "*/*" },
        body,
      });
      const text = await r.text();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e) } }));
    }
  });
}).listen(8546, "127.0.0.1", () => console.log("rpc proxy on 8546"));
