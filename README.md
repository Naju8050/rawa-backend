


•  Log in to dash.cloudflare.com.
•  In the left navigation menu, go to Storage & Databases $\rightarrow$ D1 SQL Database.
•  Click Create Database, name it rawalab-db, and select your nearest location.
•  Click on your newly created rawalab-db and navigate to the Console tab.
•  Paste the following SQL script into the query editor and click Execute:
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    role TEXT DEFAULT 'owner',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orchards (
    orchard_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    soil_type TEXT DEFAULT 'Clay-Loam',
    total_area_acres REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    orchard_id TEXT NOT NULL,
    device_type TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    battery_v REAL,
    cutoff_v REAL DEFAULT 3.49,
    ping_interval_sec INTEGER DEFAULT 300,
    last_ping INTEGER,
    is_active INTEGER DEFAULT 1,
    firmware_version TEXT,
    FOREIGN KEY (orchard_id) REFERENCES orchards(orchard_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    battery_v REAL,
    sensor_data TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_orchard ON telemetry(device_id, recorded_at);

Verification: Click the Tables tab in D1 to verify that users, orchards, devices, and telemetry are listed.

2.Create KV Namespace:1 min.
1.	In the left sidebar, navigate to Storage & Databases $\rightarrow$ KV.
2.	Click Create Namespace.
3.	Name the namespace RAWALAB_KV and click Add.
Verification: RAWALAB_KV appears in the KV namespaces list with 0 keys.

3.Create the Cloudflare Worker:2 min.
1.	In the left sidebar, navigate to Compute (Workers & Pages).
2.	Click Create application $\rightarrow$ select the Workers tab $\rightarrow$ click Create Worker.
3.	Change the Worker name to rawalab-api and click Deploy.
4.	You will see a congratulations screen; click Edit code to open the browser editor.
5.	Delete the starter boilerplate, paste your complete src/index.js file into the editor, and click Deploy.
Verification: The editor status bar turns green and shows "Deployed successfully".

4.Configure Bindings & Compatibility Flags:2 min.
1.	Return to the overview page for your rawalab-api Worker by clicking the arrow back button at the top left.
2.	Click the Settings tab.

   
4.	Enable Node.js Compatibility:
o	Select the Runtime section.
o	Under Compatibility Flags, click Add flag.
o	Type or select nodejs_compat.
o	Click Save.

5.	Bind D1 Database:
o	Select the Bindings section.
o	Click Add $\rightarrow$ choose D1 database.
o	Set Variable name to exactly: DB
o	Select your D1 database: rawalab-db
o	Click Save.
6.	Bind KV Namespace:
o	In the same Bindings section, click Add $\rightarrow$ choose KV namespace.
o	Set Variable name to exactly: RAWALAB_KV
o	Select your KV namespace: RAWALAB_KV
o	Click Save.

Verification: Under Worker Settings $\rightarrow$ Bindings, you should see both DB (D1) and RAWALAB_KV (KV) listed.

5.Add HiveMQ Cloud Secrets:2 min.
1.	Still under Settings, navigate to Variables and Secrets.
2.	Under Environment Variables, click Add for each:
o	Variable name: HIVEMQ_HOST | Value: Your cluster URL (e.g., xxxxxxxx.s1.eu.hivemq.cloud, without https:// or ports).
o	Variable name: HIVEMQ_USER | Value: Your HiveMQ Access Management username.
o	Variable name: HIVEMQ_PASS | Value: Your HiveMQ Access Management password (click Encrypt to store it as a secret).

4.	Click Save and Deploy.
Verification: HIVEMQ_HOST, HIVEMQ_USER, and HIVEMQ_PASS (marked as encrypted) appear in your environment variables list.
6.Deploy Command Center Dashboard via Pages:1 min.

1.	In the left sidebar, navigate to Compute (Workers & Pages).
2.	Click Create application $\rightarrow$ select the Pages tab.
3.	Choose Upload assets (Direct Upload) and click Create a project.
4.	Project Name: rawalab-dashboard.
5.	On your computer, open public/index.html in any text editor:
o	Replace https://rawalab-api.<your-subdomain>.workers.dev in the JavaScript section with your actual Worker route (found on your rawalab-api overview page).
6.	Place index.html into a folder named dist or public on your desktop, and drag that folder into the Cloudflare upload zone.
7.	Click Deploy site.

