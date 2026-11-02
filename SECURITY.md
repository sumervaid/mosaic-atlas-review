# Security

## Credentials

The platform asks for file paths and stores file paths alone, in `runs/gcp_settings.json` with owner-only permissions.

- The service account key stays on the local machine. The contents stay out of logs, API responses, and the Google Cloud machine.
- The Hugging Face token file is copied to the Google Cloud machine, with access limited to the user of the machine.
- `gcloud` uses a private configuration folder, leaving the personal login of a researcher unchanged.
- The repository ignores `keys/`, `*.key.json`, `.env`, and `runs/`.

`./scripts/gcp_create_key.sh MY_PROJECT --remove` deletes the service account and both local files.

## Network

The API listens on localhost. On a Google Cloud machine, researchers reach the API through an SSH tunnel, with the firewall left unchanged.

## Experiments

AI agents produce text as the sole output. Recording and stopping stay outside the control of AI agents. Any future tool access for AI agents belongs behind independently tested sandboxes.

## Reporting a vulnerability

Please report a vulnerability privately through the security advisories of this repository.
