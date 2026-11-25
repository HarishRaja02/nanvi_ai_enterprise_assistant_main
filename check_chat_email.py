import os
from dotenv import load_dotenv

load_dotenv()
from backend.security.authorization.abac import UserAttributes
from backend.chat.service import ChatService

service = ChatService.__new__(ChatService)
user = UserAttributes("3be0ecca-ae9e-49ab-9720-4d7510c87675", "enterprise-tenant", None, frozenset())
answer, files, sources = service._handle_direct_email_query(user, "recent outlook emails", limit=5)
print("Outlook Answer:\n", answer)