# WhatsApp

Primary channel. Adapter responsibilities:

- Verify Meta signatures  
- Normalize inbound text / buttons / lists / commands  
- Deliver text, reply buttons, CTA URL, **Flows** (in-chat bottom sheet), lists, templates  
- Idempotent webhook handling  
- Map phone → Azap user via existing `four_whatsapp_links`  

Do **not** put financial business logic in the webhook controller.

Slash `/` and `/help` are powered by the **Capability Registry**.  
Natural language still goes through Conversation Core → ActionPlan.

## PIN setup (in-WhatsApp bottom sheet)

"Set up your PIN" should open a **WhatsApp Flow** sheet inside the chat (like Mono’s passcode UI), **not** Safari via CTA URL.

| Piece | Detail |
| --- | --- |
| Flow JSON | `src/modules/four/whatsapp/flows/pinSetupFlowJson.ts` |
| Send | `sendWhatsappPinSetupFlow` — interactive `type: flow` |
| Complete | webhook `nfm_reply` → `handleWhatsappPinFlowCompletion` |
| Fallback | If `META_WHATSAPP_PIN_FLOW_ID` / `_NAME` unset (or send fails), CTA URL to `www.dayfi.co/setup-pin` |

### Publish the Flow once

```bash
npx ts-node -r dotenv/config scripts/publish-azap-pin-flow.ts
```

Requires `META_WHATSAPP_ACCESS_TOKEN` + `META_WHATSAPP_WABA_ID`.  
Then set on VPS:

```bash
META_WHATSAPP_PIN_FLOW_ID=<id from script>
META_WHATSAPP_PIN_FLOW_NAME=azap_pin_setup_v1
```

**Meta requirement:** Flows publish/send need a **verified Meta Business**.  
If health shows `141010 The Business has not passed business verification`, finish verification in Business Settings → Security Center. Until then:

- Flow stays `DRAFT`
- Set `META_WHATSAPP_PIN_FLOW_MODE=draft` to test the sheet with WABA admins/testers
- Production users keep getting the Safari CTA fallback if Flow send fails

Redeploy / restart the API container after updating env.

### Manual alternative (Meta UI)

1. WhatsApp Manager → Flows → Create  
2. Paste JSON from `AZAP_PIN_SETUP_FLOW_JSON` (static, no endpoint)  
3. Publish → copy Flow ID into `META_WHATSAPP_PIN_FLOW_ID`
