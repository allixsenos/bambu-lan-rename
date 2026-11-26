#!/usr/bin/env node
/**
 * Rename a Bambu Lab printer that is in LAN-only mode, without the Bambu cloud.
 *
 * Unofficial. Not affiliated with, and not endorsed by, Bambu Lab.
 *
 * The official apps rename a printer through a cloud HTTP call, so they cannot
 * rename a printer that is in LAN-only mode. The printer firmware itself
 * accepts the new name as a message on its local MQTT broker:
 *
 *     topic    device/<serial>/request
 *     payload  {"update": {"sequence_id": "<id>", "name": "<new name>"}}
 *
 * The printer answers on `device/<serial>/report` with the same `update`
 * object plus `"result": "success"`, and then announces the new name in its
 * SSDP discovery broadcasts.
 *
 * Bambu Lab does not document this command. The GitHub user synman found it
 * and reported it on 2026-03-04 in OpenBambuAPI issue #46:
 * https://github.com/Doridian/OpenBambuAPI/issues/46
 *
 * This tool was tested on a P2S with firmware 01.02.00.00 and 01.03.00.00.
 *
 * Usage:
 *     bambu-lan-rename list
 *     bambu-lan-rename rename --host <ip> "<new name>"
 */

import dgram from "node:dgram";
import os from "node:os";
import { parseArgs } from "node:util";
import mqtt from "mqtt";

// The local MQTT broker on the printer: TLS on port 8883, fixed user name,
// and the access code from the printer screen as the password.
const MQTT_PORT = 8883;
const MQTT_USER = "bblp";

// Bambu printers announce themselves with SSDP on these UDP ports, not on the
// standard SSDP port 1900.
const SSDP_GROUP = "239.255.255.250";
const SSDP_PORTS = [1990, 2021];
const SSDP_SEARCH = Buffer.from(
  "M-SEARCH * HTTP/1.1\r\n" +
    `HOST: ${SSDP_GROUP}:1990\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    "MX: 3\r\n" +
    "ST: urn:bambulab-com:device:3dprinter:1\r\n" +
    "\r\n",
);

// The sweep (the --sweep option) sends the search request to each address on
// the local subnets. A subnet larger than this prefix length has too many addresses, so the
// sweep ignores it.
const SWEEP_MIN_PREFIX = 20;
const SWEEP_BATCH = 128;

const USAGE = `Rename a Bambu Lab printer in LAN-only mode.
Unofficial. Not affiliated with, and not endorsed by, Bambu Lab.

Usage:
  bambu-lan-rename list [--sweep]
  bambu-lan-rename rename --host <ip> "<new name>"

Options:
  --sweep              list: also ask each address on the local subnets
  --host <ip>          IP address of the printer
  --serial <serial>    serial number of the printer (default: from discovery)
  --timeout <seconds>  time to wait for the printer (default: 10)
  -h, --help           show this text

Environment:
  BAMBU_ACCESS_CODE    access code of the printer (default: ask at a prompt)`;

/** Return the headers of an SSDP packet as an object with lowercase keys. */
function parseSsdp(packet) {
  const headers = {};
  for (const line of packet.toString("utf8").split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  return headers;
}

/**
 * Return each host address on the local IPv4 subnets, without our own
 * addresses. These are the targets of the sweep in `discover`.
 */
function localSubnetAddresses() {
  const toNumber = (address) => address.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0);
  const toAddress = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const own = new Set();
  const targets = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const iface of addresses ?? []) {
      if (iface.family !== "IPv4" || iface.internal || !iface.cidr) continue;
      own.add(iface.address);
      const prefix = Number(iface.cidr.split("/")[1]);
      if (prefix < SWEEP_MIN_PREFIX || prefix > 30) continue;
      const size = 2 ** (32 - prefix);
      const network = Math.floor(toNumber(iface.address) / size) * size;
      // Skip the first address (the network) and the last one (broadcast).
      for (let host = 1; host < size - 1; host++) targets.add(toAddress(network + host));
    }
  }
  for (const address of own) targets.delete(address);
  return [...targets];
}

/**
 * Find Bambu printers on the local network.
 *
 * Sends an SSDP search request to the multicast group, and also listens for
 * SSDP broadcasts. Each printer answers the search request, but the answer
 * comes from an address that we did not send to. A host firewall that blocks
 * incoming connections (the macOS application firewall, for example) drops it.
 *
 * Options:
 * - `onlyHost`: also send the search request to this address, and stop as
 *   soon as this printer answers.
 * - `sweep`: also send the search request to each address on the local
 *   subnets. An answer to one of these requests is a reply to our own
 *   packet, so a firewall lets it in. Off by default, because it sends some
 *   thousand packets to addresses that are not printers.
 *
 * Resolves to a Map from each printer IP address to
 * `{name, serial, model, firmware}`.
 */
function discover(timeoutSeconds, { onlyHost, sweep = false } = {}) {
  return new Promise((resolve) => {
    const printers = new Map();
    const sockets = [];
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // The socket never opened or is already closed.
        }
      }
      resolve(printers);
    };
    const timer = setTimeout(finish, timeoutSeconds * 1000);

    const onMessage = (packet, remote) => {
      const headers = parseSsdp(packet);
      if (!("devname.bambu.com" in headers)) return; // some other kind of device
      printers.set(remote.address, {
        name: headers["devname.bambu.com"],
        serial: headers.usn ?? "",
        model: headers["devmodel.bambu.com"] ?? "",
        firmware: headers["devversion.bambu.com"] ?? "",
      });
      if (onlyHost && printers.has(onlyHost)) finish();
    };

    for (const port of SSDP_PORTS) {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sockets.push(socket);
      socket.on("message", onMessage);
      // Another program (Bambu Studio, for example) can own the port. The
      // other port and the search request below still work.
      socket.on("error", () => {});
      socket.bind(port, () => {
        try {
          socket.addMembership(SSDP_GROUP);
        } catch {
          // No multicast on this interface. The search request still works.
        }
      });
    }

    // The printer sends its answer to a search request back to this socket.
    const search = dgram.createSocket("udp4");
    sockets.push(search);
    search.on("message", onMessage);
    search.on("error", () => {});
    search.bind(() => {
      const targets = [SSDP_GROUP];
      if (onlyHost) targets.push(onlyHost);
      if (sweep) targets.push(...localSubnetAddresses());
      // Send in batches. One burst of some thousand packets can fill the
      // send buffer, and the system then drops packets without an error.
      const sendBatch = () => {
        if (finished) return;
        for (const target of targets.splice(0, SWEEP_BATCH)) {
          for (const port of SSDP_PORTS) {
            search.send(SSDP_SEARCH, port, target, () => {});
          }
        }
        if (targets.length > 0) setTimeout(sendBatch, 20);
      };
      sendBatch();
    });
  });
}

/**
 * Send the rename command. Resolves to the `update` object of the answer.
 *
 * Rejects if the broker refuses the connection (a wrong access code, for
 * example) or if the printer does not answer in `timeoutSeconds`.
 */
function rename(host, serial, accessCode, name, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    // A sequence id of our own lets us find the answer among the status
    // reports that the printer sends all the time.
    const sequenceId = String(Date.now());
    const request = { update: { sequence_id: sequenceId, name } };

    const client = mqtt.connect({
      protocol: "mqtts",
      host,
      port: MQTT_PORT,
      username: MQTT_USER,
      password: accessCode,
      // The printer uses a certificate that a private Bambu Lab CA signed,
      // for its serial number and not for its IP address. A normal check
      // always fails, so the check is off. Use this only on a network that
      // you trust.
      rejectUnauthorized: false,
      reconnectPeriod: 0, // one attempt, no automatic reconnect
      connectTimeout: timeoutSeconds * 1000,
    });

    const settle = (action, value) => {
      clearTimeout(timer);
      client.end(true);
      action(value);
    };
    const timer = setTimeout(
      () => settle(reject, new Error("The printer did not answer the rename command.")),
      timeoutSeconds * 1000,
    );

    client.on("error", (error) => settle(reject, error));
    client.on("connect", () => {
      client.subscribe(`device/${serial}/report`, (error) => {
        if (error) return settle(reject, error);
        client.publish(`device/${serial}/request`, JSON.stringify(request));
      });
    });
    client.on("message", (_topic, payload) => {
      let update;
      try {
        update = JSON.parse(payload.toString()).update;
      } catch {
        return; // not JSON, so not the answer
      }
      if (update && update.sequence_id === sequenceId) settle(resolve, update);
    });
  });
}

/** Ask for the access code on the terminal without showing what is typed. */
function askAccessCode() {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) {
      reject(new Error("No terminal for the prompt. Set BAMBU_ACCESS_CODE."));
      return;
    }
    stderr.write("Access code: ");
    stdin.setRawMode(true);
    stdin.resume();
    let code = "";
    const done = (action, value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      action(value);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return done(resolve, code);
        if (char === "\u0003") return done(reject, new Error("Canceled.")); // Ctrl-C
        if (char === "\u007f" || char === "\b") code = code.slice(0, -1);
        else code += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function cmdList(timeout, sweep) {
  const printers = await discover(timeout, { sweep });
  if (printers.size === 0) {
    console.error("No printers found.");
    if (!sweep) console.error("A firewall on this computer can block the answers. Try again with --sweep.");
    return 1;
  }
  for (const address of [...printers.keys()].sort()) {
    const info = printers.get(address);
    console.log([address, info.serial, info.model, info.firmware, info.name].join("\t"));
  }
  return 0;
}

async function cmdRename(host, name, serial, timeout) {
  if (!serial) {
    // The MQTT topic contains the serial number. Get it from discovery so
    // the user only has to supply the IP address.
    serial = (await discover(timeout, { onlyHost: host })).get(host)?.serial;
    if (!serial) {
      console.error("Could not find the serial number. Supply it with --serial.");
      return 1;
    }
  }

  // Never take the access code as an argument: arguments are visible in the
  // process list and in the shell history.
  const accessCode = process.env.BAMBU_ACCESS_CODE || (await askAccessCode());

  const answer = await rename(host, serial, accessCode, name, timeout);
  if (answer.result !== "success") {
    console.error(`Rename failed: ${answer.reason ?? JSON.stringify(answer)}`);
    return 1;
  }

  // The MQTT answer only says that the printer accepted the command. The
  // name in the discovery broadcast is what other programs see.
  const announced = (await discover(timeout, { onlyHost: host })).get(host)?.name;
  if (announced === name) {
    console.log(`${host} is now ${announced}`);
  } else {
    console.log(`${host} accepted the name, but discovery shows: ${JSON.stringify(announced)}`);
  }
  return 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      serial: { type: "string" },
      timeout: { type: "string", default: "10" },
      sweep: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, name] = positionals;
  const timeout = Number(values.timeout);

  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (!(timeout > 0)) {
    console.error("--timeout must be a number of seconds greater than 0.");
    return 1;
  }
  if (command === "list" && positionals.length === 1) {
    return cmdList(timeout, values.sweep);
  }
  if (command === "rename" && positionals.length === 2 && values.host) {
    return cmdRename(values.host, name, values.serial, timeout);
  }
  console.error(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  },
);
