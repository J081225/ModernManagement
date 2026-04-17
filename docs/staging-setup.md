# Staging Environment Setup Guide

This guide walks through creating a complete staging environment for testing the `fix/multi-tenancy` branch before merging to production. Follow every step exactly as written.

**Production reference:**
- Render service: ModernManagement (deployed from `main` branch)
- Neon database: `neondb` on cluster `ep-red-star-an47bxr0`
- Domain: modernmanagementapp.com
- GitHub repo: J081225/ModernManagement

---

## Section A: Create a Neon Staging Database Branch

Neon's branching feature creates an instant copy of your production database. The staging branch will have all of production's schema and data, but changes to staging will NOT affect production.

### Step 1: Open Neon Console

1. Open your browser and go to **https://console.neon.tech**
2. Sign in with the account that owns the production database
3. You should see your project listed on the dashboard. Click on the project that contains your production database (the one on cluster `ep-red-star-an47bxr0`)

### Step 2: Navigate to Branches

1. Once inside the project, look at the **left sidebar**
2. Click **"Branches"** in the sidebar navigation
3. You should see a branch called **`main`** (this is Neon's default branch name, and it holds your production data)

### Step 3: Create the Staging Branch

1. Click the **"Create Branch"** button (it may also appear as **"+ New Branch"** depending on the current Neon UI)
2. A form will appear. Fill it out as follows:

   | Field | Value |
   |---|---|
   | **Branch name** | `staging` |
   | **Parent branch** | `main` (this is the production branch) |
   | **Include data** | Yes / enabled (this copies all current production data into the staging branch) |
   | **Point in time** | Leave at "Head" / current (you want the latest data) |

3. Click **"Create Branch"** (or **"Create"**)
4. Wait a few seconds. Neon will create the branch. You will see it appear in the branches list.

### Step 4: Get the Staging Connection String

1. After the branch is created, click on the **`staging`** branch name in the branches list
2. Look for **"Connection Details"** or **"Connection string"** on the branch page. In newer Neon UI, this may be on the branch overview or under a "Connect" button.
3. Make sure the connection details show:
   - **Branch:** `staging` (NOT `main`)
   - **Database:** `neondb`
   - **Role:** `neondb_owner`
4. Copy the **full connection string**. It will look something like this:

   ```
   postgresql://neondb_owner:AbCdEf123456@ep-XXXXX-YYYYY.us-east-1.aws.neon.tech/neondb?sslmode=require
   ```

   **Important:** The hostname (`ep-XXXXX-YYYYY...`) will be DIFFERENT from your production hostname. That is correct — each Neon branch gets its own compute endpoint.

5. **Save this connection string** somewhere safe (a text file, a note, etc.). You will paste it into Render in Section B.

### Step 5: Verify the Staging Branch Has Data

1. In the left sidebar, click **"SQL Editor"**
2. At the top of the SQL Editor, make sure the **branch dropdown** is set to **`staging`** (not `main`)
3. Run this query:

   ```sql
   SELECT id, username FROM users ORDER BY id;
   ```

4. You should see the admin user (and any other users from production). This confirms the data was copied.
5. If the table is empty or you get an error, go back to Step 3 and ensure "Include data" was enabled when creating the branch.

---

## Section B: Create a Render Staging Service

This creates a separate Render web service that deploys the `fix/multi-tenancy` branch, connected to the staging database.

### Step 1: Open Render Dashboard

1. Open your browser and go to **https://dashboard.render.com**
2. Sign in with the account that owns the production ModernManagement service

### Step 2: Create a New Web Service

1. Click the **"+ New"** button in the top-right area of the dashboard
2. From the dropdown, select **"Web Service"**

### Step 3: Connect the GitHub Repository

1. Render will ask you to connect a repository
2. Search for or select **J081225/ModernManagement** (the same repo your production service uses)
3. Click **"Connect"** next to the repository

### Step 4: Configure the Service

Fill in the configuration fields exactly as follows:

| Setting | Value |
|---|---|
| **Name** | `modernmanagement-staging` |
| **Region** | Virginia (US East) — same as production |
| **Branch** | `fix/multi-tenancy` |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | Free |

**Critical:** Double-check that the **Branch** field says `fix/multi-tenancy`, NOT `main`. This is the entire point of the staging environment — testing the multi-tenancy fix before it reaches production.

### Step 5: Create the Service

1. Click **"Create Web Service"** at the bottom of the page
2. Render will begin building and deploying. **The first deploy will fail** because the environment variables are not set yet. That is expected — proceed to Step 6.

### Step 6: Add Environment Variables

1. In the Render dashboard, click on **modernmanagement-staging** to open the service
2. In the left sidebar, click **"Environment"**
3. Add each environment variable below **one at a time**. Click "Add Environment Variable" for each row.

**To copy values from production:** Open a new browser tab, go to Render dashboard, click on your production **ModernManagement** service, go to Environment, and reference the values there. Do NOT change production values.

#### Required Environment Variables

**1. DATABASE_URL**
- **Key:** `DATABASE_URL`
- **Value:** Paste the staging Neon connection string you saved from Section A, Step 4
- **Example:** `postgresql://neondb_owner:AbCdEf123456@ep-XXXXX-YYYYY.us-east-1.aws.neon.tech/neondb?sslmode=require`
- **WARNING:** This MUST be the staging connection string, NOT the production one. The hostname should be different from production.

**2. SESSION_SECRET**
- **Key:** `SESSION_SECRET`
- **Value:** Generate a new random secret. Open a terminal on your computer and run:
  ```bash
  node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
  ```
  Copy the long hex string it outputs and paste it as the value.
- **WARNING:** Do NOT reuse production's SESSION_SECRET. Using a different secret means production sessions cannot be used on staging and vice versa.

**3. ANTHROPIC_API_KEY**
- **Key:** `ANTHROPIC_API_KEY`
- **Value:** Copy the exact value from your production Render service's environment variables
- This is the same key — AI features will work the same way on staging

**4. SENDGRID_API_KEY**
- **Key:** `SENDGRID_API_KEY`
- **Value:** Copy the exact value from production

**5. SENDGRID_FROM_EMAIL**
- **Key:** `SENDGRID_FROM_EMAIL`
- **Value:** Copy from production, or use a different sender address to distinguish staging emails from production emails

**6. TWILIO_ACCOUNT_SID**
- **Key:** `TWILIO_ACCOUNT_SID`
- **Value:** Copy the exact value from production

**7. TWILIO_AUTH_TOKEN**
- **Key:** `TWILIO_AUTH_TOKEN`
- **Value:** Copy the exact value from production

**8. TWILIO_PHONE_NUMBER**
- **Key:** `TWILIO_PHONE_NUMBER`
- **Value:** `+15555550000`
- **Note:** This is a fake number. Staging will not send real SMS messages. Using a fake number ensures no accidental texts are sent to real people during testing.

**9. STRIPE_SECRET_KEY**
- **Key:** `STRIPE_SECRET_KEY`
- **Value:** A Stripe **test mode** key (starts with `sk_test_...`)
- **How to find it:**
  1. Go to **https://dashboard.stripe.com/test/apikeys**
  2. Make sure the toggle at the top says **"Test mode"** (not "Live mode")
  3. Copy the **Secret key** (it starts with `sk_test_`)
- **WARNING:** Do NOT use your production live Stripe key (`sk_live_...`) on staging

**10. STRIPE_WEBHOOK_SECRET**
- **Key:** `STRIPE_WEBHOOK_SECRET`
- **Value:** Leave empty (just add the key with a blank value), or create a test webhook secret from Stripe's test mode dashboard
- This is optional for staging testing

**11. STRIPE_PRO_PRICE_ID**
- **Key:** `STRIPE_PRO_PRICE_ID`
- **Value:** Create a test-mode product in Stripe and use its price ID, or leave empty
- This is optional for staging testing

**12. APP_URL**
- **Key:** `APP_URL`
- **Value:** `https://modernmanagement-staging.onrender.com`
- **Note:** If Render assigned a different URL to your staging service, use that URL instead. You can find it at the top of the service page in Render dashboard.

**13. ADMIN_USERNAME**
- **Key:** `ADMIN_USERNAME`
- **Value:** `admin`

**14. ADMIN_PASSWORD**
- **Key:** `ADMIN_PASSWORD`
- **Value:** `stagingtest2026`
- **Note:** This is intentionally different from production. The staging admin has its own password.

### Step 7: Save and Deploy

1. After adding ALL environment variables, click **"Save Changes"** (or the save button)
2. Then click **"Manual Deploy"** in the top-right area, and select **"Deploy latest commit"**
   - Alternatively, if Render shows a "Save, rebuild, and deploy" option, click that
3. Wait for the build and deploy to complete. Watch the **Logs** in the Render dashboard. It should take approximately 2-3 minutes.
4. Look for a log line indicating the server has started (something like `Server running on port ...`)

### Step 8: Verify the Staging Service Is Running

1. Open a new browser tab
2. Go to **https://modernmanagement-staging.onrender.com** (or whatever URL Render assigned)
3. You should see the Modern Management login page
4. Log in with:
   - Username: `admin`
   - Password: `stagingtest2026`
5. If the page loads and you can log in, the staging service is running correctly

**Troubleshooting:** If the page does not load or shows an error:
- Go to the Render dashboard and check the **Logs** for error messages
- The most common issue is a wrong DATABASE_URL — verify it points to the staging Neon branch, not production
- If you see "relation does not exist" errors, the staging branch may not have included data. Go back to Section A and recreate the branch with data included.

---

## Section C: Create Test Users and Assign Routing Values

This section creates two test user accounts and assigns each one a unique phone number and email alias. These routing values are how the multi-tenancy fix determines which user an inbound message belongs to.

### Step 1: Create Test User A

1. Open your browser and go to **https://modernmanagement-staging.onrender.com/signup** (the staging signup page)
2. Fill in the registration form:
   - **Username:** `testusera`
   - **Password:** `testtest123`
   - **Email:** `testusera@test.com`
3. Click the signup/register button
4. You should be logged in as `testusera`. Verify you see the dashboard.
5. **Log out** (click the logout button or navigate to the logout URL)

### Step 2: Create Test User B

1. Go to **https://modernmanagement-staging.onrender.com/signup** again
2. Fill in the registration form:
   - **Username:** `testuserb`
   - **Password:** `testtest123`
   - **Email:** `testuserb@test.com`
3. Click the signup/register button
4. Verify you see the dashboard as `testuserb`
5. **Log out**

### Step 3: Assign Routing Values via SQL

Now you need to set each test user's Twilio phone number and inbound email alias in the database. These are the values the multi-tenancy fix uses to route incoming messages to the correct user.

1. Open a new browser tab and go to **https://console.neon.tech**
2. Click on your project
3. In the left sidebar, click **"Branches"**
4. Click on the **`staging`** branch
5. In the left sidebar, click **"SQL Editor"**
6. **Verify** the branch dropdown at the top of the SQL Editor says **`staging`** (CRITICAL: do not run these queries on `main`/production)

### Step 4: Check User IDs

Run this query in the SQL Editor:

```sql
SELECT id, username FROM users ORDER BY id;
```

You should see output like:

| id | username |
|---|---|
| 1 | admin |
| 2 | testusera |
| 3 | testuserb |

The exact IDs may differ if there were already users in the production database that was copied. Note the IDs — the important thing is that `testusera` and `testuserb` exist.

### Step 5: Assign User A's Routing Values

Run this query:

```sql
UPDATE users SET 
  twilio_phone_number = '+15555550001',
  inbound_email_alias = 'usera-test@inbound.modernmanagementapp.com'
WHERE username = 'testusera';
```

You should see: `UPDATE 1` (meaning 1 row was updated).

### Step 6: Assign User B's Routing Values

Run this query:

```sql
UPDATE users SET
  twilio_phone_number = '+15555550002',
  inbound_email_alias = 'userb-test@inbound.modernmanagementapp.com'
WHERE username = 'testuserb';
```

You should see: `UPDATE 1`.

### Step 7: Verify the Assignments

Run this query:

```sql
SELECT id, username, twilio_phone_number, inbound_email_alias FROM users;
```

Expected output:

| id | username | twilio_phone_number | inbound_email_alias |
|---|---|---|---|
| 1 | admin | (null or production number) | (null or production alias) |
| 2 | testusera | +15555550001 | usera-test@inbound.modernmanagementapp.com |
| 3 | testuserb | +15555550002 | userb-test@inbound.modernmanagementapp.com |

**Confirm:**
- `testusera` has phone `+15555550001` and email alias `usera-test@inbound.modernmanagementapp.com`
- `testuserb` has phone `+15555550002` and email alias `userb-test@inbound.modernmanagementapp.com`
- The two users have DIFFERENT phone numbers and DIFFERENT email aliases

If everything looks correct, proceed to the test plan document (`docs/staging-test-plan.md`) to run the multi-tenancy tests.

---

## Quick Reference

| Item | Staging | Production |
|---|---|---|
| Render service | modernmanagement-staging | ModernManagement |
| Render URL | https://modernmanagement-staging.onrender.com | https://modernmanagementapp.com |
| Branch deployed | fix/multi-tenancy | main |
| Neon branch | staging | main |
| Database host | ep-XXXXX-YYYYY (unique to staging) | ep-red-star-an47bxr0 |
| Admin password | stagingtest2026 | (production password) |
| Twilio number | +15555550000 (fake) | (real number) |
| Stripe key | sk_test_... | sk_live_... |
