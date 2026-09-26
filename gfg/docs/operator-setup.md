# Operator setup (admin token, Vercel env)

The small serverless admin endpoints are fail-closed: they require
`GFG_OPERATOR_TOKEN` and deny a missing or wrong token. This guide sets that up
without ever committing the value.

## 1. Generate a strong token (local machine only)

```bash
openssl rand -hex 32
```

Use the output as the secret value. Never paste it into a file in this repo.

## 2. Add it to Vercel (free)

1. Vercel dashboard, open the project.
2. Settings, Environment Variables.
3. Add a new variable:
   - Key: `GFG_OPERATOR_TOKEN`
   - Value: your generated token
   - Environments: Production (and Preview if you want admin to work there too)
4. Save, then redeploy so the function picks it up.

Adding, editing, and deleting environment variables is free on every Vercel
plan, including Hobby.

## 3. Add it locally (dev only, never committed)

Add the token to your local `.env` (which is gitignored):

```
GFG_OPERATOR_TOKEN=your-generated-token
```

The local relay reads it from the environment, same as the serverless function.

## 4. Using it

Open a dashboard admin page (for example premium credit). It asks once per
session for the token, keeps it in sessionStorage, and sends it with each admin
action. Nothing is stored in code.

## 5. Rotating

To rotate, generate a new token, update the Vercel variable, redeploy, and
enter the new value on the next admin prompt. Then remove it from any local
`.env` you no longer use.

## Rules

- Never commit the token, in any file, in any branch.
- Never put it in client-served code that ships to everyone.
- `.env` stays gitignored. If the token ever leaks, rotate it.
