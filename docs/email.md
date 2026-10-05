# Email

Covemeet uses SMTP by default. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and any SMTP credentials. Local development captures messages in Mailpit. Hosted automated mail uses `covemeet.io`.

## Amazon SES on EC2

Set `MAIL_TRANSPORT=ses`, `SES_REGION`, `SES_ACCOUNT_ID`, and the exact `SES_ROLE_ARN`. Set `AWS_EC2_METADATA_SERVICE_ENDPOINT=http://169.254.169.254`. Use an instance profile with only the required SES sending permission; do not supply access keys, profiles, container credentials or endpoint overrides. The transport verifies the account and assumed role using the same temporary credentials that sign each send. IMDSv1 is disabled. The instance must require IMDSv2 and restrict metadata access to authorized application containers.

The domain must be verified in that account and region. Configure DKIM, a custom MAIL FROM domain, bounce/complaint handling and suppression before enabling customer signup. An optional `SES_CONFIGURATION_SET` selects the configured delivery-event policy. A provider acceptance response does not prove inbox delivery.

Both the core and hosted app must point `MAIL_DATABASE_URL` at the **same dedicated PostgreSQL database**. The runtime database user needs access to the `mail_send_budget` table and permission to create it on first use; use a database containing no customer data. Production requires verified TLS, with `MAIL_DATABASE_CA_FILE` when a private CA is used. Do not set connection-string options that disable verification.

The shared budget allows 200 single-recipient attempts in a rolling 24 hours and spaces permits by one second. It survives process restarts and stops sends when the database is unavailable. Failed or uncertain attempts retain their allowance. Other senders outside these applications still consume the AWS account quota; dedicate the account and keep the provider limit authoritative. Process or network delays can bunch arrivals even when permits are spaced.

SES sends use one SDK attempt, a 10-second request deadline and a 30-second overall operation deadline. There is no automatic SMTP fallback or resend after an uncertain result. Existing invitation states let the host review and explicitly retry unconfirmed invitations. Password and verification links follow their existing expiry and revocation rules.

The shared transport accepts one recipient and in-memory text/HTML/calendar content. It does not accept file/URL attachments, arbitrary headers, a caller-controlled envelope, or caller-controlled SES parameters. Message contents and credential-provider errors are not logged.

## Check locally

`npm run check`, `npm test`, and `npm run build` cover the transport and existing callers without sending email. The optional budget integration test uses `MAIL_TEST_DATABASE_URL` pointed at a disposable loopback PostgreSQL database named `covemeet_mail_test`; run `node --import tsx --test packages/mail/test/budget-postgres.integration.test.ts`. It creates and removes only its test budget rows.

Cloud delivery still needs an actual EC2 identity/permission check and a controlled delivery test. Unit tests cannot establish those external settings.
