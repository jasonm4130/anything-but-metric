terraform {
  required_version = "= 1.12.6"

  required_providers {
    cloudflare = {
      source  = "registry.terraform.io/cloudflare/cloudflare"
      version = "= 5.22.0"
    }
    # Cloudflare provider 5.22.0 to 5.26.0 has no resource for AI Gateway custom
    # providers or provider keys, so those two API objects use the REST provider.
    restful = {
      source  = "registry.terraform.io/magodo/restful"
      version = "= 0.25.2"
    }
  }

  backend "s3" {
    key    = "anything-but-metric/infra.tfstate"
    region = "auto"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
    # Supply bucket and endpoints.s3 at initialization; credentials only through
    # AWS_* env, from the per-project state credential.
    # No locking is configured. Enforce one writer externally.
  }

  # State holds the OpenRouter key written to Secrets Store, so state and saved
  # plans are encrypted client-side before they reach R2.
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }

    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }

    state {
      method   = method.aes_gcm.state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "restful" {
  base_url = "https://api.cloudflare.com/client/v4"
  security = {
    http = {
      token = {
        token = var.cloudflare_api_token
      }
    }
  }
}
