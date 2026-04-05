# Property Manager AI Platform

A minimal full-stack proof-of-concept for an AI-supported communication and operations platform for property managers.

## Features
- Unified Inbox for resident messages
- Message detail view and status workflow
- AI-based draft generation using uploaded knowledge documents
- Knowledge base management (policies and procedures)
- Automation control: auto-responses + manager review
- No external AI integration yet, uses placeholder text generation logic

## Setup
1. `cd c:\Users\jayho\.vscode\ModernManagement`
2. `npm install`
3. `npm start`
4. Open `http://localhost:4000`

## API Endpoints (examples)
- `GET /api/messages`
- `POST /api/messages`
- `GET /api/messages/:id`
- `POST /api/generate` -> produce a draft from `messageId`
- `GET /api/knowledge`
- `POST /api/knowledge`
- `GET /api/automation`
- `PUT /api/automation`

## Next extension ideas
- Attach document uploads and scanning (PDF, DOCX)
- Integrate real LLM provider (OpenAI, Azure) with prompts using knowledge docs
- Add scheduled follow-ups, events and calendar coordination
- Add user auth and multi-property support
