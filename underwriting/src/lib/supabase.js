import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://augbrysfqwgekfhfokco.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1Z2JyeXNmcXdnZWtmaGZva2NvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2ODMwNDMsImV4cCI6MjA4ODI1OTA0M30.Am3mhi4I0ymxI8QiIoocqHySdNBEfDPSiRRB1Zt3G40';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function saveDeal(deal) {
  const { data, error } = await supabase.from('saved_deals').insert(deal).select();
  if (error) throw error;
  return data[0];
}

export async function loadDeals() {
  const { data, error } = await supabase
    .from('saved_deals')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function deleteDeal(id) {
  const { error } = await supabase.from('saved_deals').delete().eq('id', id);
  if (error) throw error;
}

export async function generateDealMemo(dealData) {
  const { data, error } = await supabase.functions.invoke('deal-memo', {
    body: dealData,
  });
  if (error) throw error;
  return data.memo;
}
