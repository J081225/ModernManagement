# Staging Test Plan: Multi-Tenancy Fix

This document contains the complete test plan for verifying the `fix/multi-tenancy` branch on the staging environment. Run every test in order. All tests must pass before merging to production.

**Prerequisites:** Complete all steps in `docs/staging-setup.md` first.

---

## Important Notes

- All curl commands target the **STAGING** server at `https://modernmanagement-staging.onrender.com`. **NEVER** run these against production.
- If Render assigned a different URL to your staging service, replace `https://modernmanagement-staging.onrender.com` in every command below with your actual staging URL.
- These are **simulated webhooks** — no real SMS or email is sent. The curl commands mimic what Twilio and SendGrid would send to your server.
- After each test, verify the database state using the **Neon SQL Editor** on the **staging** branch (not main).
- Check the **Render dashboard Logs** (left sidebar of your staging service) after each test to see routing decisions and any errors.
- Run the tests from a terminal on your computer (Git Bash, PowerShell, or any terminal that supports curl).

---

## Test A: Inbound SMS to User A's Number

**Purpose:** Verify that an SMS sent to `+15555550001` (User A's assigned number) is routed to User A's inbox only, and does NOT appear in User B's inbox.

### Step 1: Send the simulated SMS webhook

Open a terminal and run this curl command:

```bash
curl -X POST https://modernmanagement-staging.onrender.com/api/sms/incoming \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=%2B15551234567&To=%2B15555550001&Body=Hey%20this%20is%20a%20test%20SMS%20from%20a%20resident&MessageSid=SM_test_001&AccountSid=AC_test"
```

**What this simulates:** A text message from phone number `+15551234567` to User A's Twilio number `+15555550001` with the body "Hey this is a test SMS from a resident".

### Step 2: Check the HTTP response

**Expected response:** HTTP 200 status with a TwiML XML body:
```xml
<Response></Response>
```
or a similar TwiML response. The important thing is that you get a 200, not a 500 or 404.

### Step 3: Check the Render logs

1. Go to the Render dashboard
2. Click on **modernmanagement-staging**
3. Click **"Logs"** in the left sidebar
4. Look for log entries related to the incoming SMS
5. **Expected:** You should see a log indicating the message was routed to the user associated with `+15555550001`. There should be NO warnings about unrecognized numbers.

### Step 4: Verify in the database

Go to **https://console.neon.tech** > your project > SQL Editor > make sure branch is **`staging`**.

**Query 1:** Check that the message was saved for User A:

```sql
SELECT id, user_id, resident, text, created_at 
FROM messages 
WHERE user_id = (SELECT id FROM users WHERE username = 'testusera') 
ORDER BY id DESC 
LIMIT 1;
```

**Expected:** One row with:
- `user_id` matching testusera's ID
- `text` containing "Hey this is a test SMS from a resident"
- `resident` containing the sender's phone number `+15551234567` (or a formatted version of it)

**Query 2:** Confirm the message did NOT leak to User B:

```sql
SELECT * FROM messages 
WHERE user_id = (SELECT id FROM users WHERE username = 'testuserb') 
  AND text LIKE '%test SMS from a resident%';
```

**Expected:** Zero rows returned. The message must NOT appear in User B's inbox.

### Result

- [ ] HTTP 200 response received
- [ ] Message appears in User A's messages (correct user_id)
- [ ] Message does NOT appear in User B's messages
- [ ] No error or warning in Render logs

---

## Test B: Inbound SMS to User B's Number

**Purpose:** Verify that an SMS sent to `+15555550002` (User B's assigned number) is routed to User B's inbox only.

### Step 1: Send the simulated SMS webhook

```bash
curl -X POST https://modernmanagement-staging.onrender.com/api/sms/incoming \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=%2B15559876543&To=%2B15555550002&Body=User%20B%20test%20message%20-%20rent%20question&MessageSid=SM_test_002&AccountSid=AC_test"
```

**What this simulates:** A text message from `+15559876543` to User B's number `+15555550002` with body "User B test message - rent question".

### Step 2: Check the HTTP response

**Expected:** HTTP 200 with TwiML XML response.

### Step 3: Verify in the database

**Query 1:** Check both recent messages to confirm they went to different users:

```sql
SELECT user_id, resident, text 
FROM messages 
ORDER BY id DESC 
LIMIT 2;
```

**Expected:** Two rows with DIFFERENT `user_id` values:
- The newest message ("User B test message - rent question") should have User B's `user_id`
- The previous message ("Hey this is a test SMS from a resident") should have User A's `user_id`

**Query 2:** Confirm the message is only in User B's inbox:

```sql
SELECT * FROM messages 
WHERE user_id = (SELECT id FROM users WHERE username = 'testuserb') 
  AND text LIKE '%rent question%';
```

**Expected:** Exactly one row.

**Query 3:** Confirm it did NOT leak to User A:

```sql
SELECT * FROM messages 
WHERE user_id = (SELECT id FROM users WHERE username = 'testusera') 
  AND text LIKE '%rent question%';
```

**Expected:** Zero rows.

### Result

- [ ] HTTP 200 response received
- [ ] Message appears in User B's messages (correct user_id)
- [ ] Message does NOT appear in User A's messages
- [ ] Two most recent messages have DIFFERENT user_ids

---

## Test C: Inbound SMS to Unassigned Number

**Purpose:** Verify that SMS messages sent to a phone number that is NOT assigned to any user are dropped cleanly, and NOT silently routed to user ID 1 (the old broken behavior).

### Step 1: Send the simulated SMS webhook

```bash
curl -X POST https://modernmanagement-staging.onrender.com/api/sms/incoming \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=%2B15559999999&To=%2B15550000000&Body=This%20should%20be%20dropped&MessageSid=SM_test_003&AccountSid=AC_test"
```

**What this simulates:** A text message from `+15559999999` to `+15550000000` (a number not assigned to any user) with body "This should be dropped".

### Step 2: Check the HTTP response

**Expected:** HTTP 200 with TwiML XML response. The server must ALWAYS return 200 to Twilio even when dropping a message, otherwise Twilio will retry the webhook repeatedly.

### Step 3: Check the Render logs

1. Go to the Render dashboard > modernmanagement-staging > Logs
2. **Expected log message:** Something like:
   ```
   Inbound SMS to unrecognized number +15550000000 from +15559999999 — dropped (no user match)
   ```
   The exact wording may vary, but the log should clearly indicate the message was dropped because no user is assigned to that number.

### Step 4: Verify in the database

**Query 1:** Check that the dropped message was NOT saved:

```sql
SELECT COUNT(*) FROM messages WHERE text LIKE '%should be dropped%';
```

**Expected:** `0` (zero). The message must not exist anywhere in the messages table.

**Query 2:** Double-check that no message was sneaked into user 1's inbox:

```sql
SELECT * FROM messages 
WHERE user_id = 1 
  AND text LIKE '%should be dropped%';
```

**Expected:** Zero rows. This is the critical check. The old code would default to user_id 1 for unrecognized numbers.

### Result

- [ ] HTTP 200 response received (Twilio always needs 200)
- [ ] Message does NOT exist in the messages table at all
- [ ] Message did NOT route to user_id 1
- [ ] Render logs show the message was explicitly dropped

---

## Test D: Inbound Email to User A's Alias

**Purpose:** Verify that an inbound email to `usera-test@inbound.modernmanagementapp.com` routes to User A's inbox only.

### Step 1: Send the simulated email webhook

```bash
curl -X POST https://modernmanagement-staging.onrender.com/api/email/incoming \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "from=Alex Rivera <alex.rivera@email.com>" \
  --data-urlencode "to=usera-test@inbound.modernmanagementapp.com" \
  --data-urlencode "subject=Maintenance Request - Leaky Faucet" \
  --data-urlencode "text=Hi, my kitchen faucet has been leaking since yesterday. Can someone come take a look?"
```

**What this simulates:** An email from "Alex Rivera" (alex.rivera@email.com) to User A's email alias, with subject "Maintenance Request - Leaky Faucet".

### Step 2: Check the HTTP response

**Expected:** HTTP 200 response. The body may be JSON or plain text depending on implementation.

### Step 3: Verify in the database

**Query 1:** Find the message by subject:

```sql
SELECT user_id, resident, subject, text 
FROM messages 
WHERE subject LIKE '%Leaky Faucet%';
```

**Expected:** One row with:
- `user_id` matching testusera's ID
- `resident` containing "Alex Rivera" or "alex.rivera@email.com"
- `subject` containing "Maintenance Request - Leaky Faucet"
- `text` containing the faucet message

**Query 2:** Confirm it did NOT appear in User B's inbox:

```sql
SELECT * FROM messages 
WHERE user_id = (SELECT id FROM users WHERE username = 'testuserb') 
  AND subject LIKE '%Leaky Faucet%';
```

**Expected:** Zero rows.

### Result

- [ ] HTTP 200 response received
- [ ] Message appears with User A's user_id
- [ ] Message does NOT appear for User B
- [ ] `resident` field correctly identifies the sender

---

## Test E: Inbound Email to User B's Alias

**Purpose:** Verify that an inbound email to `userb-test@inbound.modernmanagementapp.com` routes to User B's inbox only.

### Step 1: Send the simulated email webhook

```bash
curl -X POST https://modernmanagement-staging.onrender.com/api/email/incoming \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "from=Jordan Lee <jordan.lee@email.com>" \
  --data-urlencode "to=userb-test@inbound.modernmanagementapp.com" \
  --data-urlencode "subject=Rent Question" \
  --data-urlencode "text=Hi, I wanted to ask about setting up automatic rent payments. Is that possible?"
```

**What this simulates:** An email from "Jordan Lee" to User B's email alias with subject "Rent Question".

### Step 2: Check the HTTP response

**Expected:** HTTP 200 response.

### Step 3: Verify in the database

**Query 1:** Find the message:

```sql
SELECT user_id, resident, subject 
FROM messages 
WHERE subject LIKE '%Rent Question%';
```

**Expected:** One row with User B's user_id.

**Query 2:** Confirm isolation:

```sql
SELECT * FROM messages 
WHERE user_id = (SELECT id FROM users WHERE username = 'testusera') 
  AND subject LIKE '%Rent Question%';
```

**Expected:** Zero rows. The message must NOT appear in User A's inbox.

### Result

- [ ] HTTP 200 response received
- [ ] Message appears with User B's user_id
- [ ] Message does NOT appear for User A

---

## Test F: Inbound Email to Unassigned Alias

**Purpose:** Verify that emails sent to an email alias that is NOT assigned to any user are dropped cleanly.

### Step 1: Send the simulated email webhook

```bash
curl -X POST https://modernmanagement-staging.onrender.com/api/email/incoming \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "from=Spammer <spam@evil.com>" \
  --data-urlencode "to=nobody@inbound.modernmanagementapp.com" \
  --data-urlencode "subject=You won a prize!" \
  --data-urlencode "text=Click here to claim your prize"
```

**What this simulates:** An email from a spammer to an address (`nobody@inbound.modernmanagementapp.com`) that is not assigned to any user.

### Step 2: Check the HTTP response

**Expected:** HTTP 200 response. The server should accept the webhook gracefully even when dropping the message.

### Step 3: Check the Render logs

1. Go to Render dashboard > modernmanagement-staging > Logs
2. **Expected log message:** Something like:
   ```
   Inbound email to unrecognized address(es) [nobody@inbound.modernmanagementapp.com] from spam@evil.com — dropped
   ```

### Step 4: Verify in the database

```sql
SELECT COUNT(*) FROM messages WHERE subject LIKE '%prize%';
```

**Expected:** `0` (zero). The message must not exist anywhere in the messages table.

### Result

- [ ] HTTP 200 response received
- [ ] Message does NOT exist in the messages table
- [ ] Render logs show the email was explicitly dropped

---

## Test G: Draft Isolation

**Purpose:** Verify that drafts created by one user are NOT visible to other users. This tests that the multi-tenancy fix also covers the drafts feature.

### Step 1: Create a draft as User A

1. Open your browser (a normal/non-incognito window)
2. Go to **https://modernmanagement-staging.onrender.com**
3. Log in as:
   - Username: `testusera`
   - Password: `testtest123`
4. Open the browser's **Developer Tools**:
   - **Chrome/Edge:** Press `F12` or `Ctrl+Shift+I` (Windows) / `Cmd+Option+I` (Mac)
   - **Firefox:** Press `F12` or `Ctrl+Shift+I`
5. Click the **"Console"** tab in Developer Tools
6. Paste this code into the console and press Enter:

```javascript
fetch('/api/drafts', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({content: 'User A secret draft', status: 'draft'})
}).then(r => r.json()).then(d => console.log('Created draft:', d))
```

7. **Expected console output:** Something like `Created draft: {id: ..., content: "User A secret draft", ...}`

### Step 2: Verify User A can see their own draft

In the same console, run:

```javascript
fetch('/api/drafts').then(r => r.json()).then(d => console.log('User A drafts:', d))
```

**Expected:** The output should include the draft with content "User A secret draft".

### Step 3: Check that User B cannot see User A's draft

1. Open an **Incognito/Private** browser window:
   - **Chrome:** `Ctrl+Shift+N` (Windows) / `Cmd+Shift+N` (Mac)
   - **Firefox:** `Ctrl+Shift+P` (Windows) / `Cmd+Shift+P` (Mac)
   - **Edge:** `Ctrl+Shift+N`
2. Go to **https://modernmanagement-staging.onrender.com**
3. Log in as:
   - Username: `testuserb`
   - Password: `testtest123`
4. Open Developer Tools (`F12`) and go to the **Console** tab
5. Paste this code and press Enter:

```javascript
fetch('/api/drafts').then(r => r.json()).then(d => console.log('User B drafts:', d))
```

**Expected:** The output should be an empty array `[]` or contain only drafts that User B created. User A's "secret draft" must NOT appear.

### Step 4: Verify in the database

Go to Neon SQL Editor (staging branch) and run:

```sql
SELECT id, user_id, content FROM drafts ORDER BY id;
```

**Expected:** The draft with content "User A secret draft" should have User A's `user_id`. Each draft's `user_id` should match the user who created it.

### Result

- [ ] User A can create a draft
- [ ] User A can see their own draft
- [ ] User B CANNOT see User A's draft
- [ ] Database shows correct user_id on each draft

---

## Test H: Session Persistence Across Restart

**Purpose:** Verify that user sessions survive a server restart. This ensures the session store is database-backed (not in-memory), which is important for Render's ephemeral filesystem.

### Step 1: Log in as both users

1. In a **normal browser window**, go to the staging URL and log in as `testusera` (password: `testtest123`)
2. In an **Incognito/Private window**, go to the staging URL and log in as `testuserb` (password: `testtest123`)
3. Verify both are logged in by loading the dashboard in each window

### Step 2: Trigger a server restart

1. Open a new browser tab and go to **https://dashboard.render.com**
2. Click on **modernmanagement-staging**
3. In the top area of the service page, click **"Manual Deploy"**
4. Select **"Deploy latest commit"**
5. This will rebuild and redeploy the staging service, restarting the server process
6. **Wait** for the deploy to complete. Watch the Logs tab — when you see the server startup message, the deploy is done. This usually takes 1-2 minutes.

### Step 3: Check that sessions survived

1. Go back to the **normal browser window** (where testusera was logged in)
2. **Refresh the page** (press `F5` or `Ctrl+R`)
3. **Expected:** You should still be on the dashboard, still logged in as testusera. You should NOT be redirected to the login page.
4. To double-check, open Developer Tools Console and run:

```javascript
fetch('/api/me').then(r => r.json()).then(d => console.log(d))
```

**Expected:** Output should show `testusera`'s user info (username, id, etc.).

5. Go to the **Incognito window** (where testuserb was logged in)
6. **Refresh the page**
7. **Expected:** Still logged in as testuserb.
8. In the Console, run the same check:

```javascript
fetch('/api/me').then(r => r.json()).then(d => console.log(d))
```

**Expected:** Output should show `testuserb`'s user info.

### Result

- [ ] User A is still logged in after server restart
- [ ] User B is still logged in after server restart
- [ ] `/api/me` returns correct user info for each session

---

## Summary Checklist

Run through this checklist after completing all tests:

| Test | Description | Pass? |
|---|---|---|
| A | SMS to User A's number routes to User A only | [ ] |
| B | SMS to User B's number routes to User B only | [ ] |
| C | SMS to unassigned number is dropped (not routed to user 1) | [ ] |
| D | Email to User A's alias routes to User A only | [ ] |
| E | Email to User B's alias routes to User B only | [ ] |
| F | Email to unassigned alias is dropped | [ ] |
| G | Drafts are isolated between users | [ ] |
| H | Sessions persist across server restart | [ ] |

**ALL tests must pass before proceeding.**

---

## What to Do If a Test Fails

**STOP. Do NOT merge `fix/multi-tenancy` to `main`.**

### Step 1: Document the failure

Write down:
- Which test failed (A through H)
- The exact curl command you ran (copy from your terminal)
- The HTTP response you received (status code and body)
- The database state (paste the query results from Neon SQL Editor)
- Any error messages from Render Logs

### Step 2: Investigate

1. Go to the **Render dashboard** > modernmanagement-staging > **Logs**
2. Scroll to the time of the test and look for error messages, stack traces, or unexpected log lines
3. Go to the **Neon SQL Editor** (staging branch) and check the database state:
   ```sql
   -- Check all messages
   SELECT id, user_id, resident, text, subject, created_at FROM messages ORDER BY id DESC LIMIT 10;
   
   -- Check user routing values
   SELECT id, username, twilio_phone_number, inbound_email_alias FROM users;
   
   -- Check drafts
   SELECT id, user_id, content FROM drafts ORDER BY id;
   ```

### Step 3: Fix the bug

1. On your local machine, make sure you are on the `fix/multi-tenancy` branch:
   ```bash
   git checkout fix/multi-tenancy
   ```
2. Make the necessary code changes to fix the failing test
3. Test locally if possible
4. Commit and push:
   ```bash
   git add .
   git commit -m "Fix: [describe what you fixed]"
   git push origin fix/multi-tenancy
   ```

### Step 4: Redeploy staging

- If **auto-deploy is enabled** on the Render staging service: it will redeploy automatically when you push. Wait for the deploy to complete.
- If **auto-deploy is NOT enabled**: Go to Render dashboard > modernmanagement-staging > Manual Deploy > Deploy latest commit

### Step 5: Re-run ALL tests

After the fix is deployed, run the **entire test suite** (Tests A through H), not just the one that failed. A fix for one test could break another.

---

## After All Tests Pass

Once every test (A through H) passes, follow these steps to merge to production.

### Step 1: Merge to main

Open a terminal on your local machine and run:

```bash
git checkout main
git pull origin main
git merge fix/multi-tenancy
git push origin main
```

If there are merge conflicts, resolve them carefully, then:
```bash
git add .
git commit -m "Merge fix/multi-tenancy: per-user message routing"
git push origin main
```

### Step 2: Wait for production deploy

1. Go to **https://dashboard.render.com**
2. Click on your **production** ModernManagement service (NOT the staging one)
3. Watch the Logs for the deploy to complete (usually 2-3 minutes)
4. Once deployed, visit **https://modernmanagementapp.com** and verify it loads

### Step 3: Assign your real Twilio number in production

1. Go to **https://console.neon.tech**
2. Open the SQL Editor
3. Make sure the branch dropdown is set to **`main`** (this is production)
4. Run:

```sql
UPDATE users SET twilio_phone_number = '+18555350785' WHERE id = 1;
```

5. Verify:

```sql
SELECT id, username, twilio_phone_number FROM users WHERE id = 1;
```

### Step 4: Set up email inbound routing (DNS + SendGrid)

**4a. Add MX record for inbound email subdomain:**

1. Go to your domain registrar / DNS provider for `modernmanagementapp.com`
2. Add a new **MX record**:
   - **Host / Name:** `inbound` (this creates `inbound.modernmanagementapp.com`)
   - **Priority:** `10`
   - **Value / Points to:** `mx.sendgrid.net`
   - **TTL:** 3600 (or default)
3. Save the DNS record
4. DNS propagation can take up to 24-48 hours, but often completes within an hour

**4b. Configure SendGrid Inbound Parse:**

1. Go to **https://app.sendgrid.com**
2. Navigate to **Settings** > **Inbound Parse**
3. Click **"Add Host & URL"**
4. Configure:
   - **Receiving Domain:** `inbound.modernmanagementapp.com`
   - **Destination URL:** `https://modernmanagementapp.com/api/email/incoming`
   - **Check incoming emails for spam:** Optional (recommended: Yes)
   - **Send raw:** No (use parsed format)
5. Click **"Add"**

### Step 5: Clean up staging resources

Once you are confident production is stable (wait at least a day or two):

**Delete the staging Render service:**
1. Go to **https://dashboard.render.com**
2. Click on **modernmanagement-staging**
3. Go to **Settings** (left sidebar)
4. Scroll to the bottom and click **"Delete Web Service"**
5. Confirm deletion

**Delete the staging Neon branch:**
1. Go to **https://console.neon.tech**
2. Click on your project
3. Go to **Branches** in the left sidebar
4. Click on the **`staging`** branch
5. Look for a **"Delete"** button or menu option (often three dots `...` menu)
6. Confirm deletion

The staging branch and its compute endpoint will be removed. This has no effect on the production `main` branch.
