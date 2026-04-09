name: Keep Supabase Alive
on:
  schedule:
    - cron: '0 9 * * 1,4'
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Supabase
        run: |
          curl -s -o /dev/null -w "%{http_code}" \
            "https://pwunfmpddkpymcnfiitn.supabase.co/rest/v1/kpi_process?limit=1" \
            -H "apikey: sb_publishable_PkmIYbQfhxzVubz-sV_UHQ_OOGByUmi" \
            -H "Authorization: Bearer sb_publishable_PkmIYbQfhxzVubz-sV_UHQ_OOGByUmi"
          echo " - Ping completed at $(date)"
