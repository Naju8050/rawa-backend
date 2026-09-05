// src/index.js - Complete Cloudflare Worker API with Bootstrap & Low-Latency MQTT
import { connect } from "cloudflare:sockets";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

function generateApiKey(prefix = "rawalab") {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_live_${hex}`;
}

async function hashKey(key) {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// -------------------------------------------------------------
// DIRECT TLS MQTT PUBLISHER (PORT 8883)
// -------------------------------------------------------------
function encodeLength(len) {
  const bytes = [];
  do {
    let digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit |= 0x80;
    bytes.push(digit);
  } while (len > 0);
  return bytes;
}

function encodeString(str) {
  const enc = new TextEncoder().encode(str);
  return [(enc.length >> 8) & 0xff, enc.length & 0xff, ...enc];
}

async function publishMqttCommand(env, deviceId, payloadObj) {
  if (!env.HIVEMQ_HOST || !env.HIVEMQ_USER || !env.HIVEMQ_PASS) {
    return {
      ok: false,
      reason: "HiveMQ credentials (HIVEMQ_HOST, HIVEMQ_USER, HIVEMQ_PASS) not bound in Worker settings."
    };
  }

  const cleanHost = env.HIVEMQ_HOST.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const topic = `rawalab/${deviceId}/cmd`;
  const message = JSON.stringify(payloadObj);

  let socket;
  try {
    socket = connect(
      { hostname: cleanHost, port: 8883 },
      { secureTransport: "on" }
    );

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    // 1. MQTT CONNECT Packet
    const protocolName = encodeString("MQTT");
    const clientId = encodeString(`cf_${crypto.randomUUID().slice(0, 8)}`);
    const username = encodeString(env.HIVEMQ_USER);
    const password = encodeString(env.HIVEMQ_PASS);

    const connectFlags = 0xc2; // Clean Session + User + Pass
    const keepAlive = [0x00, 0x1e]; // 30s

    const variableHeader = [...protocolName, 0x04, connectFlags, ...keepAlive];
    const connectPayload = [...clientId, ...username, ...password];
    const totalConnectLength = variableHeader.length + connectPayload.length;

    const connectPacket = new Uint8Array([
      0x10,
      ...encodeLength(totalConnectLength),
      ...variableHeader,
      ...connectPayload
    ]);

    await writer.write(connectPacket);

    // 2. Await CONNACK with 3.5s timeout
    const connackTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Handshake timeout (3.5s)")), 3500)
    );

    const { value: connackData } = await Promise.race([reader.read(), connackTimeout]);

    if (!connackData || connackData[0] !== 0x20 || connackData[3] !== 0) {
      throw new Error(`Broker rejected auth (code: ${connackData ? connackData[3] : "none"})`);
    }

    // 3. MQTT PUBLISH Packet (QoS 0)
    const topicBytes = encodeString(topic);
    const payloadBytes = Array.from(new TextEncoder().encode(message));
    const publishRemainingLength = topicBytes.length + payloadBytes.length;

    const publishPacket = new Uint8Array([
      0x30,
      ...encodeLength(publishRemainingLength),
      ...topicBytes,
      ...payloadBytes
    ]);

    await writer.write(publishPacket);

    // 4. MQTT DISCONNECT Packet
    const disconnectPacket = new Uint8Array([0xe0, 0x00]);
    await writer.write(disconnectPacket);

    writer.releaseLock();
    reader.releaseLock();
    await socket.close();

    return { ok: true, reason: null };
  } catch (err) {
    if (socket) {
      try { await socket.close(); } catch (_) {}
    }
    return { ok: false, reason: `TLS Socket Error: ${err.message}` };
  }
}

// -------------------------------------------------------------
// MAIN WORKER HANDLER
// -------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return jsonResponse({}, 200);
    }

    try {
      // -------------------------------------------------------------
      // BOOTSTRAP ENDPOINT (Nodes call this once on boot with API key)
      // -------------------------------------------------------------
      if (url.pathname === "/v1/devices/bootstrap" && request.method === "POST") {
        const { api_key } = await request.json();
        if (!api_key) return jsonResponse({ error: "api_key is required" }, 400);

        const hashedInput = await hashKey(api_key);

        const device = await env.DB.prepare(
          "SELECT device_id, orchard_id, device_type, is_active FROM devices WHERE api_key_hash = ?"
        ).bind(hashedInput).first();

        if (!device || !device.is_active) {
          return jsonResponse({ error: "Invalid or inactive device API key" }, 401);
        }

        const kvRaw = await env.RAWALAB_KV.get(`device:${device.device_id}`);
        const kvData = kvRaw ? JSON.parse(kvRaw) : {};

        return jsonResponse({
          success: true,
          device_id: device.device_id,
          device_type: device.device_type,
          mqtt: {
            broker: env.HIVEMQ_HOST,
            port: 8883,
            user: env.HIVEMQ_USER,
            pass: env.HIVEMQ_PASS,
            cmd_topic: `rawalab/${device.device_id}/cmd`,
            telemetry_topic: `rawalab/${device.device_id}/telemetry`
          },
          static_config: kvData.static_config || {}
        }, 200);
      }

      // -------------------------------------------------------------
      // LOW-LATENCY ACTUATION (Pump Now / Stop)
      // -------------------------------------------------------------
      if (url.pathname === "/v1/devices/irrigate-now" && request.method === "POST") {
        const body = await request.json();
        const { device_id, liters, zone, stop } = body;

        if (!device_id) return jsonResponse({ error: "device_id is required" }, 400);

        const mqttCommand = stop === true 
          ? { action: "PUMP_STOP" } 
          : { action: "PUMP_START", liters: parseInt(liters || 250), zone: parseInt(zone || 1) };

        // Asynchronously update KV in background to save execution time
        ctx.waitUntil((async () => {
          const kvRaw = await env.RAWALAB_KV.get(`device:${device_id}`);
          if (kvRaw) {
            const deviceData = JSON.parse(kvRaw);
            if (!deviceData.static_config) deviceData.static_config = {};
            deviceData.static_config.IRRIGATE_NOW = {
              active: !stop,
              stop_immediate: Boolean(stop),
              liters: parseInt(liters || 0),
              zone: parseInt(zone || 1),
              timestamp: Math.floor(Date.now() / 1000)
            };
            await env.RAWALAB_KV.put(`device:${device_id}`, JSON.stringify(deviceData));
          }
        })());

        // Dispatch MQTT over raw TLS socket
        const mqttResult = await publishMqttCommand(env, device_id, mqttCommand);

        return jsonResponse({
          success: true,
          kv_saved: true,
          mqtt_dispatched: mqttResult.ok,
          mqtt_error: mqttResult.ok ? null : mqttResult.reason,
          command: mqttCommand
        }, 200);
      }

      // -------------------------------------------------------------
      // SCHEDULE SYNC (Save to KV & Trigger MQTT Notification)
      // -------------------------------------------------------------
      if (url.pathname === "/v1/devices/schedules" && request.method === "POST") {
        const body = await request.json();
        const { device_id, schedules } = body;

        if (!device_id || !Array.isArray(schedules)) {
          return jsonResponse({ error: "device_id and schedules array required" }, 400);
        }

        const kvRaw = await env.RAWALAB_KV.get(`device:${device_id}`);
        if (!kvRaw) return jsonResponse({ error: "Device not found" }, 404);

        const deviceData = JSON.parse(kvRaw);
        if (!deviceData.static_config) deviceData.static_config = {};
        deviceData.static_config.SCHEDULES = schedules;

        await env.RAWALAB_KV.put(`device:${device_id}`, JSON.stringify(deviceData));
        const mqttResult = await publishMqttCommand(env, device_id, { action: "SYNC_CONFIG" });

        return jsonResponse({
          success: true,
          kv_saved: true,
          mqtt_dispatched: mqttResult.ok,
          mqtt_error: mqttResult.ok ? null : mqttResult.reason,
          schedules
        }, 200);
      }

      // -------------------------------------------------------------
      // CONFIG FETCH ROUTE (Called by nodes on SYNC_CONFIG)
      // -------------------------------------------------------------
      if (url.pathname === "/v1/devices/config" && request.method === "GET") {
        const deviceId = url.searchParams.get("device_id");
        if (!deviceId) return jsonResponse({ error: "device_id is required" }, 400);

        const kvRaw = await env.RAWALAB_KV.get(`device:${deviceId}`);
        if (!kvRaw) return jsonResponse({ error: "Not found" }, 404);

        const data = JSON.parse(kvRaw);
        return jsonResponse({
          device_id: deviceId,
          ping_interval_sec: data.ping_interval_sec,
          schedules: data.static_config?.SCHEDULES || [],
          supply_type: data.static_config?.SUPPLY_TYPE || "12V_SOLAR"
        }, 200);
      }

      // -------------------------------------------------------------
      // USERS API
      // -------------------------------------------------------------
      if (url.pathname === "/v1/users") {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
          return jsonResponse(results, 200);
        }
        if (request.method === "POST") {
          const { full_name, email, phone, role } = await request.json();
          if (!full_name || !email) return jsonResponse({ error: "full_name and email required" }, 400);
          const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
          const now = Math.floor(Date.now() / 1000);
          await env.DB.prepare(
            "INSERT INTO users (user_id, full_name, email, phone, role, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(userId, full_name, email, phone || null, role || "owner", now).run();
          return jsonResponse({ success: true, user_id: userId, full_name, email }, 201);
        }
      }

      if (url.pathname.startsWith("/v1/users/") && request.method === "DELETE") {
        const userId = url.pathname.split("/")[3];
        const { results: userDevices } = await env.DB.prepare(
          `SELECT d.device_id FROM devices d JOIN orchards o ON d.orchard_id = o.orchard_id WHERE o.user_id = ?`
        ).bind(userId).all();
        for (const row of userDevices) await env.RAWALAB_KV.delete(`device:${row.device_id}`);
        await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(userId).run();
        return jsonResponse({ success: true, message: `User ${userId} deleted` }, 200);
      }

      // -------------------------------------------------------------
      // ORCHARDS API
      // -------------------------------------------------------------
      if (url.pathname === "/v1/orchards") {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare(
            `SELECT o.*, u.full_name as owner_name FROM orchards o JOIN users u ON o.user_id = u.user_id ORDER BY o.created_at DESC`
          ).all();
          return jsonResponse(results, 200);
        }
        if (request.method === "POST") {
          const { user_id, name, latitude, longitude, soil_type, total_area_acres } = await request.json();
          if (!user_id || !name) return jsonResponse({ error: "user_id and name required" }, 400);
          const orchardId = `orch_${crypto.randomUUID().slice(0, 8)}`;
          const now = Math.floor(Date.now() / 1000);
          await env.DB.prepare(
            `INSERT INTO orchards (orchard_id, user_id, name, latitude, longitude, soil_type, total_area_acres, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(orchardId, user_id, name, latitude || null, longitude || null, soil_type || "Clay-Loam", total_area_acres || 0, now).run();
          return jsonResponse({ success: true, orchard_id: orchardId, name }, 201);
        }
      }

      if (url.pathname.startsWith("/v1/orchards/") && request.method === "DELETE") {
        const orchardId = url.pathname.split("/")[3];
        const { results: devList } = await env.DB.prepare("SELECT device_id FROM devices WHERE orchard_id = ?").bind(orchardId).all();
        for (const row of devList) await env.RAWALAB_KV.delete(`device:${row.device_id}`);
        await env.DB.prepare("DELETE FROM orchards WHERE orchard_id = ?").bind(orchardId).run();
        return jsonResponse({ success: true, message: `Orchard ${orchardId} deleted` }, 200);
      }

      // -------------------------------------------------------------
      // DEVICES API
      // -------------------------------------------------------------
      if (url.pathname === "/v1/devices") {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare(
            `SELECT d.*, o.name as orchard_name, u.full_name as owner_name
             FROM devices d
             JOIN orchards o ON d.orchard_id = o.orchard_id
             JOIN users u ON o.user_id = u.user_id
             ORDER BY d.last_ping DESC`
          ).all();
          return jsonResponse(results, 200);
        }
        if (request.method === "POST") {
          const { orchard_id, device_id, device_type, cutoff_v, ping_interval_sec } = await request.json();
          if (!orchard_id || !device_id || !device_type) {
            return jsonResponse({ error: "orchard_id, device_id, and device_type required" }, 400);
          }

          const rawKey = generateApiKey(device_type.toLowerCase());
          const hashedKey = await hashKey(rawKey);
          const cutoff = cutoff_v !== undefined ? parseFloat(cutoff_v) : 3.49;
          const pingInterval = ping_interval_sec ? parseInt(ping_interval_sec) : (device_type === "motorController" ? 5 : 300);

          await env.DB.prepare(
            `INSERT INTO devices (device_id, orchard_id, device_type, api_key_hash, cutoff_v, ping_interval_sec, is_active)
             VALUES (?, ?, ?, ?, ?, ?, 1)`
          ).bind(device_id, orchard_id, device_type, hashedKey, cutoff, pingInterval).run();

          const kvRecord = {
            api_key: rawKey,
            device_id,
            orchard_id,
            device_type,
            cutoff_v: cutoff,
            ping_interval_sec: pingInterval,
            is_active: true,
            static_config: {
              SUPPLY_TYPE: "12V_SOLAR",
              SCHEDULES: [],
              IRRIGATE_NOW: { active: false, liters: 0, zone: 1 }
            }
          };
          await env.RAWALAB_KV.put(`device:${device_id}`, JSON.stringify(kvRecord));

          return jsonResponse({
            success: true,
            device_id,
            device_type,
            orchard_id,
            device_api_key: rawKey
          }, 201);
        }
      }

      if (url.pathname.startsWith("/v1/devices/") && request.method === "DELETE") {
        const deviceId = url.pathname.split("/")[3];
        await env.RAWALAB_KV.delete(`device:${deviceId}`);
        await env.DB.prepare("DELETE FROM devices WHERE device_id = ?").bind(deviceId).run();
        return jsonResponse({ success: true, message: `Device ${deviceId} deleted` }, 200);
      }

      // -------------------------------------------------------------
      // INGESTION (Sensors & Motor Telemetry)
      // -------------------------------------------------------------
      if (url.pathname === "/v1/ingest" && request.method === "POST") {
        const body = await request.json();
        const { device_id, api_key, battery_v, firmware, sensors, ack_irrigation } = body;

        if (!device_id || !api_key || !sensors) {
          return jsonResponse({ error: "Missing required payload fields" }, 400);
        }

        const kvRaw = await env.RAWALAB_KV.get(`device:${device_id}`);
        if (!kvRaw) return jsonResponse({ error: "Node unregistered" }, 401);

        const config = JSON.parse(kvRaw);
        if (config.api_key !== api_key || !config.is_active) {
          return jsonResponse({ error: "Unauthorized node" }, 403);
        }

        if (ack_irrigation === true && config.static_config?.IRRIGATE_NOW) {
          config.static_config.IRRIGATE_NOW.active = false;
          config.static_config.IRRIGATE_NOW.stop_immediate = false;
          await env.RAWALAB_KV.put(`device:${device_id}`, JSON.stringify(config));
        }

        const now = Math.floor(Date.now() / 1000);
        const volt = battery_v !== undefined ? parseFloat(battery_v) : null;
        const lowBattery = volt !== null ? (volt <= (config.cutoff_v || 3.49)) : false;

        await env.DB.batch([
          env.DB.prepare("INSERT INTO telemetry (device_id, battery_v, sensor_data, recorded_at) VALUES (?, ?, ?, ?)").bind(device_id, volt, JSON.stringify(sensors), now),
          env.DB.prepare("UPDATE devices SET battery_v = COALESCE(?, battery_v), firmware_version = COALESCE(?, firmware_version), last_ping = ? WHERE device_id = ?").bind(volt, firmware || null, now, device_id)
        ]);

        return jsonResponse({
          status: "ok",
          timestamp: now,
          battery_warning: lowBattery,
          config: {
            ping_interval: config.ping_interval_sec,
            ...config.static_config
          }
        }, 200);
      }

      // -------------------------------------------------------------
      // TELEMETRY LOG RETRIEVAL
      // -------------------------------------------------------------
      if (url.pathname === "/v1/orchards/telemetry" && request.method === "GET") {
        const orchardId = url.searchParams.get("orchard_id");
        const range = url.searchParams.get("range") || "24h";
        if (!orchardId) return jsonResponse({ error: "orchard_id is required" }, 400);

        const now = Math.floor(Date.now() / 1000);
        let timeCondition = "";
        let params = [orchardId];

        if (range === "24h") { timeCondition = "AND t.recorded_at >= ?"; params.push(now - 86400); }
        else if (range === "7d") { timeCondition = "AND t.recorded_at >= ?"; params.push(now - 604800); }
        else if (range === "30d") { timeCondition = "AND t.recorded_at >= ?"; params.push(now - 2592000); }

        const query = `
          SELECT t.*, d.device_type FROM telemetry t
          JOIN devices d ON t.device_id = d.device_id
          WHERE d.orchard_id = ? ${timeCondition}
          ORDER BY t.recorded_at DESC LIMIT 1000
        `;
        const { results } = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse(results.map(r => ({
          ...r,
          sensors: JSON.parse(r.sensor_data)
        })), 200);
      }

      return jsonResponse({ error: "Endpoint not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};
