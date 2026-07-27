// ~15 realistic fixture emails covering the categories the digest triage
// prompt is expected to sort into Action Required / FYI / System Alerts,
// plus spam and noise that should never reach the posted digest at all.

function email(overrides) {
  return {
    id: overrides.id,
    conversationId: `conv-${overrides.id}`,
    internetMessageId: `<${overrides.id}@example.com>`,
    subject: overrides.subject,
    from: {
      emailAddress: { name: overrides.senderName, address: overrides.senderEmail },
    },
    toRecipients: [{ emailAddress: { name: 'Grant Carlson', address: 'grant@milestoneproperties.net' } }],
    ccRecipients: [],
    receivedDateTime: overrides.receivedDateTime || new Date().toISOString(),
    sentDateTime: overrides.receivedDateTime || new Date().toISOString(),
    isRead: overrides.isRead ?? false,
    hasAttachments: overrides.hasAttachments ?? false,
    importance: overrides.importance || 'normal',
    bodyPreview: overrides.bodyPreview,
    body: { contentType: 'text', content: overrides.bodyPreview },
  };
}

export const SPAM_EMAIL_INDEX = 3;

export const DIGEST_FIXTURE_EMAILS = [
  email({
    id: 'e1',
    subject: 'Invoice #4471 - Landscaping services June',
    senderName: 'GreenScape Landscaping',
    senderEmail: 'billing@greenscapewa.com',
    bodyPreview: 'Please find attached invoice #4471 for landscaping services rendered in June, due within 30 days.',
  }),
  email({
    id: 'e2',
    subject: 'Unit 204 - noise complaint from neighbor',
    senderName: 'Kelsey Dempsey',
    senderEmail: 'kelsey@milestoneproperties.net',
    bodyPreview: 'Tenant in unit 203 reported loud music from 204 again last night after 11pm. Can you follow up?',
  }),
  email({
    id: 'e3',
    subject: 'Your AppFolio daily report ran successfully',
    senderName: 'AppFolio',
    senderEmail: 'noreply@appfolio.com',
    bodyPreview: 'The scheduled daily delinquency report completed successfully with no errors.',
  }),
  email({
    id: 'e4',
    subject: 'Grow your business 10x with our SEO services!!!',
    senderName: 'Totally Legit Marketing',
    senderEmail: 'deals@totally-legit-marketing.biz',
    bodyPreview: 'Hi there, I came across your website and noticed you could use our exclusive SEO package...',
  }),
  email({
    id: 'e5',
    subject: 'BECU Loan Documents - signature required by Friday',
    senderName: 'Crystal Li',
    senderEmail: 'crystal.li@becu.org',
    bodyPreview: 'We need your signature on the attached loan documents by end of day Friday to keep the refinance on track.',
    importance: 'high',
  }),
  email({
    id: 'e6',
    subject: 'Psomas W-9 follow-up',
    senderName: 'Shannon Jensvold',
    senderEmail: 'shannon@psomas.com',
    bodyPreview: 'Following up on the W-9 request from last week, do you have an update?',
  }),
  email({
    id: 'e7',
    subject: 'Adobe Acrobat: New comment on Lease Renewal.pdf',
    senderName: 'Adobe Acrobat',
    senderEmail: 'message@adobe.com',
    bodyPreview: 'Someone commented on a shared PDF document.',
  }),
  email({
    id: 'e8',
    subject: 'Renton Ave closing - review and signature requested',
    senderName: 'Merritt Hess',
    senderEmail: 'merritt.hess@escrow.com',
    bodyPreview: 'Please review and sign the attached closing documents for 9275 Renton Ave S at your earliest convenience.',
  }),
  email({
    id: 'e9',
    subject: 'Home inspection report ready - 9275 Renton Ave S',
    senderName: 'Emily Hess',
    senderEmail: 'emily.hess@inspectco.com',
    bodyPreview: 'The home inspection report for 9275 Renton Ave S is attached and ready for your review.',
  }),
  email({
    id: 'e10',
    subject: 'Zapier automation error: delinquency-outreach',
    senderName: 'Zapier',
    senderEmail: 'notifications@zapier.com',
    bodyPreview: 'Your Zap "delinquency-outreach" failed to run due to an authentication error.',
  }),
  email({
    id: 'e11',
    subject: 'Insurance renewal reminder - Kenton property',
    senderName: 'State Farm Agent',
    senderEmail: 'agent@statefarm.com',
    bodyPreview: 'This is a reminder that your policy renewal for the Kenton property is due in 10 days.',
  }),
  email({
    id: 'e12',
    subject: 'Weekly newsletter: Property management trends',
    senderName: 'PM Industry News',
    senderEmail: 'newsletter@pmindustrynews.com',
    bodyPreview: 'This week in property management: rent trends, new regulations, and more.',
  }),
  email({
    id: 'e13',
    subject: 'Vendor W-9 attached',
    senderName: 'Jeri',
    senderEmail: 'jeri@milestoneproperties.net',
    bodyPreview: 'Attached is the signed W-9 for the new landscaping vendor.',
  }),
  email({
    id: 'e14',
    subject: 'Stolen rents - urgent',
    senderName: 'Rhoda',
    senderEmail: 'rhoda@milestoneproperties.net',
    bodyPreview: 'Flagging this as urgent -- possible stolen rent payments reported by a tenant at Galer Crest.',
    importance: 'high',
  }),
  email({
    id: 'e15',
    subject: 'Your weekly AppFolio owner statement is ready',
    senderName: 'AppFolio',
    senderEmail: 'noreply@appfolio.com',
    bodyPreview: 'Your weekly owner statement has been generated and is available in your portal.',
  }),
];
