import os

if "APP_MODE" not in os.environ:
    os.environ["APP_MODE"] = "testing"

# In local/automated pytest runs without live external network to UECP, default UECP_ENABLED to false
if "UECP_ENABLED" not in os.environ:
    os.environ["UECP_ENABLED"] = "false"

