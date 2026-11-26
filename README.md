# bambu-lan-rename

Rename a Bambu Lab printer that is in LAN-only mode. The tool does not use the Bambu cloud.

> **Unofficial tool.** This project is not affiliated with Bambu Lab. Bambu Lab does not endorse it, sponsor it, or give support for it. "Bambu Lab" is a trademark of its owner. The name is used here only to say which printers the tool works with.

## The problem

Bambu Studio and Bambu Handy rename a printer through a cloud HTTP call. A printer in LAN-only mode has no cloud connection, so the official apps cannot rename it. The usual workaround is to bind the printer to a cloud account, rename it, and then go back to LAN-only mode.

This is a problem when you have two printers of the same model. The default names are almost the same, and you cannot tell the printers apart in the slicer.

## How the tool works

The printer firmware accepts a new name on its local MQTT broker. The tool sends one message to the topic `device/<serial>/request`:

```json
{"update": {"sequence_id": "1", "name": "New name"}}
```

The printer answers on the topic `device/<serial>/report`:

```json
{"update": {"name": "New name", "reason": "success", "result": "success", "sequence_id": "1"}}
```

The printer then announces the new name in its SSDP discovery answers. Bambu Studio reads the name from SSDP discovery.

Bambu Lab does not document this command. This project did not discover it. See [Credit](#credit).

The tool uses only the local MQTT broker that Developer Mode opens, with the access code of your own printer. It does not connect to the Bambu cloud, and it does not contain Bambu Lab code.

## Requirements

- A Bambu Lab printer in LAN-only mode with Developer Mode on.
- The IP address and the access code of the printer. The printer screen shows the two values in the network settings.
- A computer on the same network as the printer.
- [Node.js](https://nodejs.org/) 18.3 or later.

## Usage

`npx` gets the tool and its one dependency, `mqtt`, when you run a command. You do not install anything.

### Find the printers

```sh
npx github:allixsenos/bambu-lan-rename list
```

The output has one line for each printer: IP address, serial number, model code, firmware version, and name.

```
192.0.2.10	01P00A000000001	N7	01.03.00.00	3DP-01P-001
192.0.2.11	01P00A000000002	N7	01.02.00.00	3DP-01P-002
```

#### If the list is empty

A firewall on your computer can block the answers from the printers. The macOS firewall does this when it shows "Do you want the application node to accept incoming network connections?" and you select Deny.

Each printer sends its answer from its own address. The tool did not send a packet to that address, so the firewall sees the answer as a new incoming connection.

There are three solutions:

- Run the command with `--sweep`. The tool then also sends the search request to each address on the local subnets. An answer to one of these requests is a reply, and the firewall lets it in.

  ```sh
  npx github:allixsenos/bambu-lan-rename list --sweep
  ```

- Let Node.js accept incoming connections. On macOS, go to System Settings > Network > Firewall > Options.
- Do not use `list`. The `rename` command with `--host` sends its packets directly to the printer, so the firewall does not block it.

The sweep is not on by default. It sends some thousand packets to addresses that are not printers. It ignores a subnet that is larger than a /20 network.

### Rename a printer

1. Run the `rename` command with the IP address of the printer and the new name.

   ```sh
   npx github:allixsenos/bambu-lan-rename rename --host 192.0.2.10 "Workshop-1"
   ```

2. Type the access code at the prompt.
3. Make sure that the tool prints the new name.

   ```
   192.0.2.10 is now Workshop-1
   ```

The tool reads the name back from SSDP discovery. This shows that other programs on the network see the new name.

### Options

| Option | Effect |
|---|---|
| `BAMBU_ACCESS_CODE` | Environment variable. If you set it, the tool does not ask for the access code. |
| `--sweep` | For `list`. Also sends the search request to each address on the local subnets. |
| `--serial <serial>` | Supplies the serial number. Use it when discovery cannot find the printer. |
| `--timeout <seconds>` | Sets the time that the tool waits for the printer. The default is 10. |

The tool does not accept the access code as an argument. Arguments are visible in the process list and in the shell history.

### Run from a clone

```sh
git clone https://github.com/allixsenos/bambu-lan-rename.git
cd bambu-lan-rename
npm install
node bambu-lan-rename.js list
```

## Credit

The GitHub user [synman](https://github.com/synman) found the rename command. On 2026-03-04, synman reported it in [OpenBambuAPI issue #46](https://github.com/Doridian/OpenBambuAPI/issues/46). The method was to rename a printer in cloud mode, read the answer on the local MQTT report topic, and send the same `update` message to a printer in LAN-only mode.

synman also maintains [bambu-printer-manager](https://github.com/synman/bambu-printer-manager), a Python library that has the same command and a [reference for the MQTT protocol](https://github.com/synman/bambu-printer-manager/blob/devel/docs/mqtt-protocol-reference.md).

This project adds a small command that runs with `npx`, SSDP discovery to find the serial number and to read the name back, and test results for the P2S.

## Tested hardware

| Printer | Firmware | Result |
|---|---|---|
| P2S | 01.02.00.00 | The rename works. |
| P2S | 01.03.00.00 | The rename works. |

Names with non-ASCII characters work. I did not test other models. For reports about other models, see [Credit](#credit).

## Limits

- The command is not documented. A firmware update can remove it.
- The test did not include a restart of the printer. It is not known if the name stays after a restart.
- The maximum length of a name is not known.
- The tool does not make sure that the TLS certificate of the printer is correct. A private Bambu Lab certificate authority signs the certificate for the serial number, not for the IP address. Use the tool only on a network that you trust.
- Programs that keep their own copy of the name do not see the change. The Home Assistant integration is an example.
- Use the tool at your own risk. It comes with no warranty.
