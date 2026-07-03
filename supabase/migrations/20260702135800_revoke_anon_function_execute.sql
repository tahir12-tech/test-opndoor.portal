-- Supabase default privileges grant EXECUTE to anon explicitly, so revoking
-- from PUBLIC alone left anon able to call our SECURITY DEFINER functions.
-- anon (pre-login) needs none of our functions, so remove them all.
revoke execute on all functions in schema public from anon;
