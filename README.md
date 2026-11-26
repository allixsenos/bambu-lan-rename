# bambu-lan-rename

Rename a Bambu Lab printer that is in LAN-only mode. The script does not use the Bambu cloud.

## The problem

Bambu Studio and Bambu Handy rename a printer through a cloud HTTP call. A printer in LAN-only mode has no cloud connection, so the official apps cannot rename it. The usual workaround is to bind the printer to a cloud account, rename it, and then go back to LAN-only mode.

This is a problem when you have two printers of the same model. The default names are almost the same, and you cannot tell the printers apart in the slicer.

## How the script works

The printer firmware accepts a new name on its local MQTT broker. The script sends one message to the topic `device/<serial>/request`:

```json
{"update": {"sequence_id": "1", "name": "New name"}}
```

The printer answers on the topic `device/<serial>/report`:

```json
{"update": {"name": "New name", "reason": "success", "result": "success", "sequence_id": "1"}}
```

The printer then announces the new name in its SSDP discovery broadcasts. Bambu Studio reads the name from these broadcasts.

Bambu Lab does not document this command. I found it by experiment.

## Requirements

- A Bambu Lab printer in LAN-only mode with Developer Mode on.
- The IP address and the access code of the printer. The printer screen shows the two values in the network settings.
- A computer on the same network as the printer.
- [uv](https://docs.astral.sh/uv/). It installs the one dependency, `paho-mqtt`, when the script starts.

## Usage

### Find the printers

```sh
uv run bambu_rename.py list
```

The output has one line for each printer: IP address, serial number, model code, firmware version, and name.

```
192.0.2.10	01P00A000000001	N7	01.03.00.00	3DP-01P-001
192.0.2.11	01P00A000000002	N7	01.02.00.00	3DP-01P-002
```

### Rename a printer

1. Run the `rename` command with the IP address of the printer and the new name.

   ```sh
   uv run bambu_rename.py rename --host 192.0.2.10 "Workshop-1"
   ```

2. Type the access code at the prompt.
3. Make sure that the script prints the new name.

   ```
   192.0.2.10 is now Workshop-1
   ```

The script reads the name back from the discovery broadcast. This shows that other programs on the network see the new name.

### Options

| Option | Effect |
|---|---|
| `BAMBU_ACCESS_CODE` | Environment variable. If you set it, the script does not ask for the access code. |
| `--serial <serial>` | Supplies the serial number. Use it when discovery cannot find the printer. |
| `--timeout <seconds>` | Sets the time that the script waits for the printer. The default is 10. Put it before the command name. |

The script does not accept the access code as an argument. Arguments are visible in the process list and in the shell history.

## Tested hardware

| Printer | Firmware | Result |
|---|---|---|
| P2S | 01.02.00.00 | The rename works. |
| P2S | 01.03.00.00 | The rename works. |

Names with non-ASCII characters work. I did not test other models.

## Limits

- The command is not documented. A firmware update can remove it.
- The test did not include a restart of the printer. It is not known if the name stays after a restart.
- The maximum length of a name is not known.
- The script does not make sure that the TLS certificate of the printer is correct. Bambu Lab's private certificate authority signs the certificate for the serial number, not for the IP address. Use the script only on a network that you trust.
- Programs that keep their own copy of the name do not see the change. The Home Assistant integration is an example.

## Notes

This project is not affiliated with Bambu Lab.
