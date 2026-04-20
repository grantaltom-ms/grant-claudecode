"""Milestone Financial Agent — Web Chat UI with Finance, Outlook, and Slack tools."""

import json
import os
import urllib.request
import urllib.error
from flask import Flask, render_template, request, Response, stream_with_context
from anthropic import Anthropic
from supabase import create_client

app = Flask(__name__)

# ---------- clients ----------
anthropic_client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
supabase = create_client(
    os.environ.get("SUPABASE_URL", ""),
    os.environ.get("SUPABASE_KEY", ""),
)

# ---------- webhook URLs ----------
ZAP_OUTLOOK_DRAFT = os.environ.get("ZAP_OUTLOOK_DRAFT", "")
ZAP_SLACK_MESSAGE = os.environ.get("ZAP_SLACK_MESSAGE", "")

# ---------- schema reference (loaded once) ----------
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "SUPABASE_SCHEMA_REFERENCE.md")
with open(SCHEMA_PATH, "r") as f:
    SCHEMA_REFERENCE = f.read()

SYSTEM_PROMPT = f"""You are the personal AI assistant for Grant Carlson, Head of Operations at Milestone Properties.
Milestone manages 50+ multifamily properties across the Seattle metro area and San Francisco.
Entities include Milestone Development LLC, Olive Street Managers LLC, Norland Investments LLC, and property-specific LLCs.

You are direct, specific, and action-oriented. You know the properties, the staff, and the workflows.

## Capabilities

You have three tools:
1. **query_database** — Run SQL against the Milestone Supabase database (GL transactions, income statements, balance sheets, 51 properties)
2. **create_email_draft** — Create a draft email in Grant's Outlook (never sends — creates a draft for review)
3. **send_slack_message** — Send a message to a Slack channel

## Financial Data Rules
- Only run SELECT queries. Use materialized views when possible (mv_annual_property_summary, mv_monthly_expenses_by_category, mv_portfolio_annual).
- Always join properties table for names. Use ILIKE for flexible matching.
- For expenses sum debit. For revenue sum credit. NOI = operating income - operating expenses.
- Format currency with commas and 2 decimals ($1,234.56). Use markdown tables for multi-row data.

## Communications Rules
- Emails are always created as DRAFTS in Outlook — never sent directly. Grant reviews before sending.
- Always include Grant's signature in email drafts.
- Be professional but warm with tenant-facing comms. Direct and action-oriented with staff.

Grant's email signature:
Grant Carlson | Head of Operations, Milestone Properties | (C) 206-553-9098 (O) 206-775-7335

## Staff Contacts
- Conor Murphy — accounting@milestoneproperties.net (bookkeeping, AP/AR)
- Sabrina Corpus — sabrina@rentmilestone.com (operations support)
- Building managers (all @rentmilestone.com unless noted):
  Andrew Riviere, Travis Zar, Shamar Wilkins, Courtney Henderson,
  Jacque Altom, Jamie Masterson, Dania Sotelo, Gregory Rubio-Licht,
  Jeri Rhodes (jeri@), Kelsey Dempsey (kelsey@), Scott Altom (scott.a@)

## Database Schema Reference

{SCHEMA_REFERENCE}"""

# ---------- tool definitions ----------
TOOLS = [
    {
        "name": "query_database",
        "description": "Execute a read-only SQL query against the Supabase PostgreSQL database. Only SELECT and WITH (CTE) queries are allowed. Returns query results as JSON.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The SQL SELECT query to execute. Must not have leading whitespace."
                }
            },
            "required": ["query"],
        },
    },
    {
        "name": "create_email_draft",
        "description": "Create a draft email in Grant's Outlook inbox for review before sending. Always include Grant's full signature. The draft will NOT be sent automatically — Grant will review it first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {
                    "type": "string",
                    "description": "Recipient email address"
                },
                "subject": {
                    "type": "string",
                    "description": "Email subject line"
                },
                "body": {
                    "type": "string",
                    "description": "Full email body including Grant's signature at the bottom"
                }
            },
            "required": ["to", "subject", "body"],
        },
    },
    {
        "name": "send_slack_message",
        "description": "Send a message to a Slack channel. Use for staff updates, operational announcements, and internal communications.",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel": {
                    "type": "string",
                    "description": "Slack channel name (e.g., '#general', '#ops-updates', '#maintenance')"
                },
                "message": {
                    "type": "string",
                    "description": "Message text. Supports Slack markdown formatting."
                }
            },
            "required": ["channel", "message"],
        },
    },
]


# ---------- tool executors ----------
def execute_query(sql: str) -> str:
    """Run a read-only SQL query via Supabase exec_sql RPC."""
    sql = sql.strip()
    if not sql.upper().startswith(("SELECT", "WITH")):
        return json.dumps({"error": "Only SELECT and WITH queries are allowed."})
    try:
        result = supabase.rpc("exec_sql", {"query": sql}).execute()
        return json.dumps(result.data, default=str)
    except Exception as e:
        return json.dumps({"error": str(e)})


def trigger_webhook(url: str, payload: dict) -> str:
    """POST JSON payload to a Zapier webhook URL."""
    if not url:
        return json.dumps({"error": "Webhook URL not configured. Ask Grant to set it up in Zapier."})
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            result = response.read().decode("utf-8")
            return json.dumps({"success": True, "status": response.status, "response": result})
    except urllib.error.HTTPError as e:
        return json.dumps({"success": False, "status": e.code, "error": e.read().decode("utf-8")})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


def create_email_draft(to: str, subject: str, body: str) -> str:
    """Create an Outlook draft via Zapier webhook."""
    return trigger_webhook(ZAP_OUTLOOK_DRAFT, {
        "to": to,
        "subject": subject,
        "body": body,
        "action": "create_draft",
    })


def send_slack_message(channel: str, message: str) -> str:
    """Send a Slack message via Zapier webhook."""
    return trigger_webhook(ZAP_SLACK_MESSAGE, {
        "channel": channel,
        "text": message,
    })


def execute_tool(tool_name: str, tool_input: dict) -> str:
    """Dispatch a tool call to the appropriate handler."""
    if tool_name == "query_database":
        return execute_query(tool_input.get("query", ""))
    elif tool_name == "create_email_draft":
        return create_email_draft(
            to=tool_input.get("to", ""),
            subject=tool_input.get("subject", ""),
            body=tool_input.get("body", ""),
        )
    elif tool_name == "send_slack_message":
        return send_slack_message(
            channel=tool_input.get("channel", ""),
            message=tool_input.get("message", ""),
        )
    else:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})


# ---------- routes ----------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.json
    messages = data.get("messages", [])

    def generate():
        current_messages = list(messages)

        while True:
            response = anthropic_client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=current_messages,
            )

            assistant_content = response.content
            has_tool_use = False

            for block in assistant_content:
                if block.type == "text":
                    yield f"data: {json.dumps({'type': 'text', 'content': block.text})}\n\n"
                elif block.type == "tool_use":
                    has_tool_use = True
                    tool_name = block.name
                    tool_input = block.input
                    tool_use_id = block.id

                    # Show user-friendly tool indicator
                    indicator = {
                        "query_database": f"Querying database...",
                        "create_email_draft": f"Creating Outlook draft...",
                        "send_slack_message": f"Sending Slack message...",
                    }.get(tool_name, f"Running {tool_name}...")

                    yield f"data: {json.dumps({'type': 'tool_call', 'name': tool_name, 'indicator': indicator})}\n\n"

                    # Execute the tool
                    result = execute_tool(tool_name, tool_input)

                    # Add assistant message and tool result to conversation
                    current_messages.append({"role": "assistant", "content": assistant_content})
                    current_messages.append({
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": result,
                            }
                        ],
                    })

            if not has_tool_use:
                break

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"Starting Milestone Financial Agent on http://localhost:{port}")
    if not ZAP_OUTLOOK_DRAFT:
        print("  ⚠ ZAP_OUTLOOK_DRAFT not set — email drafts will fail")
    if not ZAP_SLACK_MESSAGE:
        print("  ⚠ ZAP_SLACK_MESSAGE not set — Slack messages will fail")
    app.run(host="0.0.0.0", port=port, debug=True)
