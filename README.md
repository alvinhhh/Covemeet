# Covemeet

Covemeet is self-hosted video meeting software. Guests join in their browser with a link or a meeting code and password. No app to install, no guest account to create.

Built with React, TypeScript, LiveKit, Fastify, PostgreSQL and Redis.

## Features

- **Meetings and webinars** with screen sharing, chat, and presenter/viewer roles.
- **Host controls** for admitting guests, locking meetings, muting microphones, disabling cameras, kicking participants and banning them from a meeting.
- **Breakout rooms** with separate chat, host announcements and return-to-main controls.
- **Custom branding** with your own name, logo, background and landing page.
- **Optional encrypted recordings** with password-protected, revocable 24-hour download links. Self-hosted installations can use their own recording keys.
- **Flexible setup** with custom meeting codes and separate domains for the control panel and meetings.

## Quick start

You'll need Node.js 22.12+, npm and Docker Compose.

```sh
npm ci
npm run setup
docker compose --profile mail up -d --wait
npm run dev
```

Open [localhost:5173](http://localhost:5173), create a meeting and share the guest link and password. Join from another browser profile to try the lobby and host controls.

The setup script generates `.env` and the local service configuration. Use `CREATION_KEY` from `.env` when creating meetings or editing branding. Test emails appear in [Mailpit](http://localhost:8025).

For a Docker setup with HTTPS and separate portal and meeting domains, follow the [local HTTPS guide](docs/local-https.md).

## Development

```sh
npm run check
npm test
npm run build
```

| Directory | Contents |
| --- | --- |
| `apps/web` | Meeting UI and self-hosted control panel |
| `apps/api` | Meetings, permissions, recordings and signaling |
| `apps/phone` | Experimental SIP gateway and audio relay |
| `packages/recording` | Recording encryption and storage |
| `infra` | Docker, proxy and media-server configuration |
| `scripts/validation` | Media and integration tests |

## Documentation

- [Self-hosting and configuration](docs/deployment.md)
- [Local HTTPS setup](docs/local-https.md)
- [Recording storage and encryption keys](docs/recording-storage.md)
- [Phone and SIP development](docs/phone-sip-design.md)
- [Security](docs/security-controls.md)
- [Roadmap and project status](docs/requirements-ledger.md)

## Contributing

Bug reports and pull requests are welcome. Include steps to reproduce bugs, and run the checks above before submitting code changes.

Covemeet Hosted is maintained separately and uses this core. Changes to meetings, media and self-hosting belong here.

## License

[Apache 2.0](LICENSE).
