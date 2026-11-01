# A user's LLM key is encrypted with a secret from the environment

Each user's LLM API key (D16) is stored in the database encrypted (AES-256-GCM) with a key derived
from `TRIPS_LLM_SECRET`, an environment variable of the server. The API never returns a saved key,
only whether one is set. A database dump, including Gallery's automatic backups that sit next to
the library, is then useless for spending someone's API credit without the compose file as well.
The price: one more variable to set, and losing or changing it makes every saved key unreadable,
so users enter them again. Without the variable no key can be saved and generation that needs one
is off, with a message naming the variable; an OpenAI-compatible server without a key (a local
model) still works.

## Considered Options

- Plain text, write-only through the API, as Immich keeps its OAuth client secret and SMTP
  password: no setup, but the key lies readable in every database dump.
- A secret the server writes to a file on first start: no setup, but the file would sit beside the
  database backups and protect little, and an S3 instance has no obvious place for it.
- One instance-wide key in the environment: simplest, but drops D16's per-user key.
