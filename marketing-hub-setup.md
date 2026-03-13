# Marketing Hub Skill — Setup

Skill location: `~/Desktop/marketing-hub/`
Symlink: `~/.claude/skills/marketing-hub → ~/Desktop/marketing-hub`

## Projects

| Project | Metrika Counter |
|---------|----------------|
| prostobox.com | 57275935 |
| pochtoy.com | 21491899 |
| qwixit.com | 95499360 |
| garage.pochtoy.com | 107082295 |
| garage.prostobox.com | 107082444 |
| Dzen | 107309881 |

Telegram: `@pochtoycom`, `@prostoboxme`

## Credentials

Stored in `~/Desktop/marketing-hub/.env` (not committed to git).
See `~/Desktop/marketing-hub/.env.example` for variable names.

## Restore

```bash
# Re-create symlink after fresh clone or setup
mkdir -p ~/.claude/skills
ln -sf ~/Desktop/marketing-hub ~/.claude/skills/marketing-hub
```
