# Mailbox sign-in providers (operator guide)

People can connect their mailbox by signing in with a provider instead of typing an app password. The product names no provider: the server operator lists the providers in a JSON file and points `MAIL_OAUTH_PROVIDERS_FILE` at it. The file is read at run time; keep it outside the repository, readable by the API user only (it holds client secrets).

Each entry:

```json
[
  {
    "key": "work-mail",
    "name": "Work Mail",
    "authorizeUrl": "https://login.provider.example/oauth2/authorize",
    "tokenUrl": "https://login.provider.example/oauth2/token",
    "scopes": ["openid", "email", "offline_access", "<the provider's IMAP and SMTP scopes>"],
    "clientId": "<client id>",
    "clientSecret": "<client secret>",
    "authorizeParams": { "prompt": "consent" },
    "imap": { "host": "imap.provider.example", "port": 993, "secure": true },
    "smtp": { "host": "smtp.provider.example", "port": 465, "secure": true }
  }
]
```

- `name` is what people see on the button ("Sign in with Work Mail").
- Register the redirect address `https://<your app host>/api/v1/email/oauth/callback` with the provider.
- The provider must return an ID token with the person's email (`openid email` scopes) and a refresh token (often `offline_access`, or `access_type=offline` and `prompt=consent` in `authorizeParams`).
- IMAP and SMTP must accept OAuth access tokens (XOAUTH2).
- Tokens are stored encrypted with the instance key ring and re-encrypted by `npm run cli -w @app/api -- crypto:rotate`.
