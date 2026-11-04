import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { XAMAN_DEFICIT_TTL_MINUTES } from "../params.js";

const API_URL = "https://xumm.app/api/v1/platform";

export function createXamanClient({
  apiKey = process.env.XAMAN_API_KEY,
  apiSecret = process.env.XAMAN_API_SECRET,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey || !apiSecret) throw new Error("XAMAN_API_KEY and XAMAN_API_SECRET are required");
  const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  const request = async (path, init = {}) => {
    const response = await fetchImpl(`${API_URL}${path}`, {
      ...init,
      headers: {
        authorization,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok || data?.error) {
      throw new Error(`Xaman API request failed (${response.status})`);
    }
    return data;
  };

  return {
    async createSigningPayload(txjson, { identifier, instruction, ttlMinutes } = {}) {
      const data = await request("/payload", {
        method: "POST",
        body: JSON.stringify({
          txjson,
          options: { force_network: "MAINNET", ...(ttlMinutes ? { expire: ttlMinutes } : {}) },
          custom_meta: { identifier, instruction },
        }),
      });
      const uuid = data.uuid ?? data.payload_uuidv4;
      if (typeof uuid !== "string" || !data.next?.always) {
        throw new Error("Xaman returned an incomplete signing payload");
      }
      return {
        uuid,
        url: data.next.always,
        qr: data.refs?.qr_png,
      };
    },

    async getPayload(uuid) {
      const data = await request(`/payload/${encodeURIComponent(uuid)}`);
      if (data.meta?.uuid !== uuid && data.meta?.payload_uuidv4 !== uuid) {
        throw new Error("Xaman payload identifier mismatch");
      }
      return data;
    },

    verifyWebhookSignature({ timestamp, signature, body, secret = apiSecret }) {
      if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp) ||
          typeof signature !== "string" || !/^[0-9a-f]{40}$/i.test(signature)) return false;
      const expected = createHmac("sha1", secret.replaceAll("-", ""))
        .update(timestamp + JSON.stringify(body))
        .digest();
      const received = Buffer.from(signature, "hex");
      return received.length === expected.length && timingSafeEqual(received, expected);
    },
  };
}

export function loadXamanClient({
  credentialsDir = process.env.CREDENTIALS_DIRECTORY,
  readCredential = (path) => readFileSync(path, "utf8").trim(),
} = {}) {
  if (!credentialsDir) throw new Error("CREDENTIALS_DIRECTORY required for Xaman credentials");
  return createXamanClient({
    apiKey: readCredential(`${credentialsDir}/xaman_api_key`),
    apiSecret: readCredential(`${credentialsDir}/xaman_api_secret`),
  });
}

export async function requestDeficitApproval({
  xummClient, txjson, loanId, ttlMinutes = XAMAN_DEFICIT_TTL_MINUTES,
} = {}) {
  if (!xummClient) throw new Error("Xaman client is required for house shortfall approval");
  if (typeof xummClient.createSigningPayload === "function") {
    return xummClient.createSigningPayload(txjson, {
      identifier: loanId,
      instruction: `Approve the exact house shortfall for loan ${loanId}`,
      ttlMinutes,
    });
  }
  if (typeof xummClient.payload?.create !== "function") {
    throw new Error("Xaman client does not support signing payload creation");
  }
  return xummClient.payload.create({ txjson, options: { expire: ttlMinutes } });
}
