#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// On ESP32-C3 SuperMini / Mini boards: GPIO 8
// Active-LOW logic: LOW = ON, HIGH = OFF
#define LED_PIN 8
#define LED_ON  LOW
#define LED_OFF HIGH

// ================= HARDCODED NETWORK & BOOTSTRAP ENDPOINT =================
static const char* WIFI_SSID     = "iPhone";
static const char* WIFI_PASS     = "aaaaaaaa";
static const char* BOOTSTRAP_URL = "https://rawalab-api.najeebshafins-ns.workers.dev/v1/devices/bootstrap";

// ================= DYNAMIC RUNTIME IDENTITY (STORED IN NVS) =================
Preferences prefs;
static char device_api_key[64]   = "";
static char device_id[32]        = "";
static char hivemq_broker[96]    = "";
static int  hivemq_port          = 8883;
static char hivemq_user[48]      = "";
static char hivemq_pass[48]      = "";
static char cmd_topic[64]        = "";
static char telemetry_topic[64]  = "";

WiFiClientSecure tlsClient;
PubSubClient mqttClient(tlsClient);

static void set_led(bool state) {
  digitalWrite(LED_PIN, state ? LED_ON : LED_OFF);
}

// -------------------------------------------------------------
// 1. SERIAL FACTORY PROVISIONING
// -------------------------------------------------------------
void handle_serial_provisioning() {
  prefs.begin("rawalab_cfg", false);
  String stored_key = prefs.getString("api_key", "");

  if (stored_key.length() > 0) {
    strncpy(device_api_key, stored_key.c_str(), sizeof(device_api_key) - 1);
    Serial.printf("[NVS] Loaded Provisioned API Key: %s\n", device_api_key);
  } else {
    Serial.println("\n==================================================");
    Serial.println("   RAWALAB UNPROVISIONED FIELD NODE DETECTED      ");
    Serial.println("==================================================");
    Serial.print("Enter Device API Key: ");

    String inputKey = "";
    while (inputKey.length() == 0) {
      if (Serial.available() > 0) {
        inputKey = Serial.readStringUntil('\n');
        inputKey.trim();
      }
      delay(50);
    }

    strncpy(device_api_key, inputKey.c_str(), sizeof(device_api_key) - 1);
    prefs.putString("api_key", device_api_key);
    Serial.println("\n[NVS] Key securely committed to flash memory.");
    Serial.printf("[NVS] Active Key: %s\n", device_api_key);
  }
  prefs.end();
}

// -------------------------------------------------------------
// 2. BOOTSTRAP IDENTITY FROM CLOUDFLARE WORKER
// -------------------------------------------------------------
bool bootstrap_device() {
  Serial.println("[BOOTSTRAP] Querying edge for device credentials...");

  HTTPClient http;
  http.begin(BOOTSTRAP_URL);
  http.addHeader("Content-Type", "application/json");

  char body[128];
  snprintf(body, sizeof(body), "{\"api_key\":\"%s\"}", device_api_key);

  int code = http.POST((uint8_t*)body, strlen(body));
  if (code != 200) {
    Serial.printf("[BOOTSTRAP] Failed with HTTP code: %d\n", code);
    if (code == 401) {
      Serial.println("[BOOTSTRAP] Unauthorized! Clearing invalid key from NVS...");
      prefs.begin("rawalab_cfg", false);
      prefs.clear();
      prefs.end();
      Serial.println("[SYSTEM] Please reboot and enter a valid API key.");
    }
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();

  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.println("[BOOTSTRAP] JSON parse failed.");
    return false;
  }

  strncpy(device_id, doc["device_id"] | "UNKNOWN", sizeof(device_id) - 1);
  strncpy(hivemq_broker, doc["mqtt"]["broker"] | "", sizeof(hivemq_broker) - 1);
  hivemq_port = doc["mqtt"]["port"] | 8883;
  strncpy(hivemq_user, doc["mqtt"]["user"] | "", sizeof(hivemq_user) - 1);
  strncpy(hivemq_pass, doc["mqtt"]["pass"] | "", sizeof(hivemq_pass) - 1);
  strncpy(cmd_topic, doc["mqtt"]["cmd_topic"] | "", sizeof(cmd_topic) - 1);
  strncpy(telemetry_topic, doc["mqtt"]["telemetry_topic"] | "", sizeof(telemetry_topic) - 1);

  Serial.printf("[BOOTSTRAP] Identity assigned: %s\n", device_id);
  Serial.printf("[BOOTSTRAP] Subscribed Topic: %s\n", cmd_topic);
  return true;
}

// -------------------------------------------------------------
// 3. MQTT COMMAND DISPATCHER
// -------------------------------------------------------------
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, payload, length);

  if (err) {
    if (length > 0 && (payload[0] == '1' || payload[0] == 'O' || payload[0] == 'o')) {
      set_led(true);
      Serial.println("[LED] State -> ON (Raw Text)");
    } else {
      set_led(false);
      Serial.println("[LED] State -> OFF (Raw Text)");
    }
    return;
  }

  const char* action = doc["action"];
  if (!action) return;

  if (strcmp(action, "PUMP_START") == 0) {
    set_led(true);
    Serial.printf("[PUMP] ON | Target: %u Liters | Zone: %u\n", doc["liters"] | 0, doc["zone"] | 1);
  } 
  else if (strcmp(action, "PUMP_STOP") == 0) {
    set_led(false);
    Serial.println("[PUMP] OFF | Stop Executed");
  }
}

// -------------------------------------------------------------
// 4. MQTT RECONNECT LOOP
// -------------------------------------------------------------
void reconnectMqtt() {
  while (!mqttClient.connected()) {
    Serial.print("[MQTT] Connecting to HiveMQ TLS...");
    
    // Unique client ID based on hardware MAC
    String clientId = String(device_id) + "_" + String((uint32_t)ESP.getEfuseMac(), HEX);

    if (mqttClient.connect(clientId.c_str(), hivemq_user, hivemq_pass)) {
      Serial.println(" Connected!");
      mqttClient.subscribe(cmd_topic, 0); // QoS 0 for minimal latency
      Serial.printf("[MQTT] Subscribed: %s\n", cmd_topic);
    } else {
      Serial.printf(" Connect error state=%d. Retrying in 2.5s...\n", mqttClient.state());
      delay(2500);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  set_led(false);

  // 1. Read or prompt for API Key via Serial
  handle_serial_provisioning();

  // 2. Connect to Wi-Fi
  //WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("[WIFI] Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(200);
    Serial.print(".");
  }
  Serial.println(" Connected.");

  // CRITICAL: Disable modem sleep for instant radio reaction
  WiFi.setSleep(false);

  // 3. Bootstrap device identity
  while (!bootstrap_device()) {
    Serial.println("[SYSTEM] Retrying bootstrap in 5 seconds...");
    delay(5000);
  }

  // 4. Connect to HiveMQ Cloud TLS
  tlsClient.setInsecure();
  mqttClient.setServer(hivemq_broker, hivemq_port);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setBufferSize(512);
}

void loop() {
  if (!mqttClient.connected()) {
    reconnectMqtt();
  }
  mqttClient.loop();delay(10);
}
