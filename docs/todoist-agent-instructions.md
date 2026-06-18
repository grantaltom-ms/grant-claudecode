# Todoist Routine Agent — Email Task Extraction
## Instructions for Grant Carlson / Milestone Properties

---

## Purpose

This agent reviews Grant's incoming emails and creates Todoist tasks for anything that requires a follow-up action. It runs after the morning digest and operates on the same 24-hour email window.

The goal is not to create a task for every email — it's to extract only the things that will slip through the cracks without a reminder.

---

## Step 1: Load Existing Tasks FIRST (Required Before Creating Anything)

Before evaluating any emails, retrieve two lists from Todoist:

**A. All open tasks** — fetch active tasks with the label `email`. These are things Grant hasn't done yet.

**B. Recently completed tasks** — fetch tasks completed in the last 14 days with the label `email`. These are things Grant already handled and checked off.

Store both lists in memory. You will check against them before creating any new task.

---

## Step 2: Deduplication Check

For each email that would otherwise generate a task, run this check before creating anything:

### Check 1 — Is there already an open task for this?
Search open tasks for matches on ANY of:
- Same sender name or domain (e.g. "Crystal Li" or "becu.org")
- Same subject keywords (strip Re:/Fwd: prefixes, then compare core words)
- Same invoice number, property address, or deal name if present

If a matching open task exists → **skip creation entirely**. The task is already waiting for Grant to act on it. Do not create a duplicate.

### Check 2 — Did Grant recently complete a task for this?
Search completed tasks (last 14 days) for the same matches above.

If a matching completed task exists → **skip creation**. Grant already handled it. Do not resurface it just because a follow-up email arrived in the same thread, unless the new email clearly introduces a *new* action (e.g. a new invoice number, a new deadline, a new request that's distinct from the original).

### Check 3 — Is this a reply in an ongoing thread?
If the email subject starts with Re: or Fwd: and refers to the same topic as an existing open or completed task → **skip creation** unless the new email changes the situation (new deadline, new request, new urgency).

### When to override the deduplication and create anyway
Only create a new task if the new email introduces something genuinely new:
- A different invoice number or amount
- A new deadline that didn't exist before
- A request for a different action (e.g. first email asked for a reply, new email asks for a signature)
- The previously completed task was finished weeks ago and the issue has re-opened

When overriding, note in the task description what's new about this one.

---

## When to Create a Task

Create a Todoist task when the email requires:
- A response or reply that hasn't happened yet
- A payment, approval, or signature
- A decision or follow-up call
- Forwarding information or looping someone in
- Reviewing a document before a deadline
- Following up if you don't hear back within a set window

**Do NOT create tasks for:**
- Automated system notifications (AppFolio, DocuSign confirmations, etc.)
- Newsletters or marketing emails
- Informational FYIs with no action required
- Emails Grant has already read and replied to (isRead = true AND recent reply exists)
- Daily/weekly reports that just confirm the system ran
- Any email that matches an existing open or recently completed task (see deduplication above)

---

## Task Format

### Title
Keep titles short and action-oriented. Start with a verb.

**Good:**
- Reply to Crystal Li — loan status update (BECU)
- Pay Bill's Glass Co. invoice #66657 ($853.17) ⚠️ overdue
- Review home inspection report — 9275 Renton Ave S
- Follow up with Merritt Hess — signature request

**Avoid:**
- "Email from Crystal Li about loan"
- "RE: Fw: Fwd: Invoice attached"
- Long descriptive sentences

### Description (optional but useful)
Add a one-line note if the context would help Grant remember what this is when he sees it later:
- "Invoice attached, due Apr 27 — already 2 weeks overdue"
- "Windermere wants signature on purchase docs before closing Friday"

### Due Date
- If the email mentions a specific deadline, use that date
- If it's an overdue invoice, set due date to today
- For general follow-ups with no deadline, set due date to tomorrow
- For "respond when you have a chance" type emails, set due date 2 days out
- If a follow-up is needed because you haven't heard back, set due date 5–7 days out

### Priority
Use Todoist priority levels:
- **P1** (red): Overdue invoices, signature deadlines, legal/lender items, anything explicitly urgent
- **P2** (orange): Active deals requiring action, client-facing replies needed within 24–48 hours
- **P3** (blue): Internal follow-ups, routine vendor replies, informational responses
- **P4** (no priority): Low-stakes tasks, things that can wait a week+

### Project Assignment
Route tasks to the correct Todoist project based on context:
- Property deals / acquisitions → **Acquisitions** (or property-specific project if exists)
- Vendor invoices / payments → **Operations**
- Lender / financing items → **Finance**
- Internal team coordination → **Operations**
- Leasing / tenant items → **Leasing**
- Default if unclear → **Inbox**

### Labels / Tags
Always apply:
- `email` — apply to every task created from email (used for deduplication lookups)

Apply when relevant:
- `overdue` — when a payment or deadline has passed
- `lender` — for BECU, financing, or loan-related items
- `vendor` — for contractor, vendor, or supplier emails
- `tenant` — for tenant or resident communications
- `legal` — for anything involving contracts, notices, attorneys
- `property:[location]` — e.g. `property:renton`, `property:burien`, `property:seatac`

---

## Property Context

When an email references a specific property, include the address or city in the task title and apply the appropriate property label.

**Known properties:** Burien, SeaTac, Renton, Tukwila (extract from email context)

**Address format:** If a full address is mentioned (e.g. 9275 Renton Ave S), include it in the task title for easy scanning.

---

## Key Contacts Reference

Use this to recognize who emails are from and route tasks appropriately:

| Contact | Role | Context |
|---|---|---|
| Crystal Li, Jawad Habibi | BECU | Lender — financing/loan items → Finance |
| Josh (Alpine CPAs) | CPA | Accounting/tax items → Finance |
| Shannon Jensvold (Psomas) | Consultant | Project/consulting items → Operations |
| Merritt Hess | Windermere agent | Deal/acquisition items → Acquisitions |
| Conor Murphy | Internal — Accounting | Internal items → Operations |
| Rhoda | Principal | High priority — flag P1 or P2 |
| Jamie Masterson | Internal — Leasing | Leasing items → Leasing |
| Kelsey Dempsey | Internal — Property Mgr | Operations |

---

## Overdue Invoice Handling

When an email contains an unpaid invoice:
1. **Check completed tasks first** — if Grant already marked a "Pay [vendor]" task as done recently, skip it
2. Create a P1 task if it's past due (only if no matching completed task exists)
3. Create a P2 task if it's due within 7 days
4. Include the invoice number and dollar amount in the task title
5. Tag with `vendor` and `overdue` as appropriate

Example: `Pay Bill's Glass Co. invoice #66657 — $853.17 [OVERDUE since Apr 27]`

---

## After Creating Tasks

Post a brief summary to #inbox-digest as a thread reply to the morning digest:

```
*✅ Todoist — [N] tasks added, [N] skipped (already exists or completed):*
• [Task title] — due [date]
• [Task title] — due [date]
```

If no tasks were needed, post: `*Todoist: No new tasks needed — all actions already tracked or completed.*`

Always report how many were skipped due to deduplication so Grant can see the agent is working correctly and not just silently doing nothing.
