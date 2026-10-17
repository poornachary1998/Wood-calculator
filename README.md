# Wood Cut-List Extractor

Upload a photo of a handwritten wood cut-list, extract the measurements with the Gemini API (vision), and calculate area totals.

## To run it

```
npm install
cp .env.example .env        # then paste GEMINI_API_KEY=... into it (get one free at aistudio.google.com)
npm run dev
# open http://localhost:3000
```

`npm start` runs the server without auto-reload.

### Backup Gemini key

Set `GEMINI_API_KEY_BACKUP` (in `.env`, or in Netlify under Site configuration →
Environment variables) to a second Gemini key. When the main key's quota runs
out or the key stops working, extraction automatically retries with the backup
key before falling back to Claude. Create the backup key in a different Google
Cloud project or Google account — keys in the same project share one quota.
