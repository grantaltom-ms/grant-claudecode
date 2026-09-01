// lib/mailbox-folders.js
// Native Outlook mail folder management via Microsoft Graph, requiring the
// MailboxFolder.ReadWrite application permission (see
// docs/system-reference.md). Lets the assistant organize triage state
// (needs reply / waiting on / snoozed) as real folders Grant can see and
// use natively in Outlook, instead of only as status flags in Supabase.

import { graph } from './graph';

// Display names for the custom triage folders this app manages, created as
// direct children of Inbox on first use. 'Inbox' and 'Archive' are Graph's
// own well-known folders and are addressed directly by name/id, not via
// this map.
export const TRIAGE_FOLDERS = {
  needs_reply: 'Needs Reply',
  waiting_on: 'Waiting On',
  snoozed: 'Snoozed',
};

export async function listMailFolders(token, ownerEmail, parentFolderId = null) {
  const base = parentFolderId
    ? `/users/${ownerEmail}/mailFolders/${parentFolderId}/childFolders`
    : `/users/${ownerEmail}/mailFolders`;
  const result = await graph(token, `${base}?$select=id,displayName,parentFolderId,unreadItemCount,totalItemCount&$top=100`);
  return result.value || [];
}

export async function createMailFolder(token, ownerEmail, displayName, parentFolderId = null) {
  const base = parentFolderId
    ? `/users/${ownerEmail}/mailFolders/${parentFolderId}/childFolders`
    : `/users/${ownerEmail}/mailFolders`;
  return graph(token, base, 'POST', { displayName });
}

export async function renameMailFolder(token, ownerEmail, folderId, displayName) {
  return graph(token, `/users/${ownerEmail}/mailFolders/${folderId}`, 'PATCH', { displayName });
}

export async function deleteMailFolder(token, ownerEmail, folderId) {
  return graph(token, `/users/${ownerEmail}/mailFolders/${folderId}`, 'DELETE');
}

export async function moveMessageToFolder(token, ownerEmail, messageId, destinationFolderId) {
  return graph(token, `/users/${ownerEmail}/messages/${messageId}/move`, 'POST', {
    destinationId: destinationFolderId,
  });
}

// Resolves the Graph folder id for one of TRIAGE_FOLDERS' keys, using
// Supabase (`mailbox_folders`) as a cache so a normal move doesn't need to
// list Inbox's child folders every time. Creates the folder in Outlook (and
// caches it) the first time it's needed; a folder created manually in
// Outlook ahead of time is picked up by display name instead of duplicated.
export async function resolveTriageFolderId(supabase, token, ownerEmail, triageKey) {
  const displayName = TRIAGE_FOLDERS[triageKey];
  if (!displayName) throw new Error(`Unknown triage folder: ${triageKey}`);

  const { data: cached } = await supabase
    .from('mailbox_folders')
    .select('graph_folder_id')
    .eq('owner_email', ownerEmail)
    .eq('folder_key', triageKey)
    .maybeSingle();
  if (cached?.graph_folder_id) return cached.graph_folder_id;

  const inboxChildren = await listMailFolders(token, ownerEmail, 'Inbox');
  let folder = inboxChildren.find(f => f.displayName === displayName);
  if (!folder) folder = await createMailFolder(token, ownerEmail, displayName, 'Inbox');

  await supabase
    .from('mailbox_folders')
    .upsert(
      { owner_email: ownerEmail, folder_key: triageKey, display_name: displayName, graph_folder_id: folder.id },
      { onConflict: 'owner_email,folder_key' }
    );

  return folder.id;
}
