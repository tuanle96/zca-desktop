use object_store::aws::AmazonS3Builder;
use object_store::memory::InMemory;
use object_store::ObjectStore;

use crate::config::Config;

pub fn build_s3_store(config: &Config) -> object_store::Result<Box<dyn ObjectStore>> {
    if config.s3_endpoint.is_none()
        && std::env::var("ZCA_CLOUD_OBJECT_STORE").as_deref() != Ok("s3")
    {
        return Ok(Box::new(InMemory::new()));
    }
    let mut builder = AmazonS3Builder::new().with_bucket_name(&config.s3_bucket);
    if let Some(endpoint) = &config.s3_endpoint {
        builder = builder.with_endpoint(endpoint);
    }
    if let Some(access_key_id) = &config.s3_access_key_id {
        builder = builder.with_access_key_id(access_key_id);
    }
    if let Some(secret_access_key) = &config.s3_secret_access_key {
        builder = builder.with_secret_access_key(secret_access_key);
    }
    if config.s3_allow_http {
        builder = builder.with_allow_http(true);
    }
    Ok(Box::new(builder.build()?))
}

pub fn object_key(user_id: uuid::Uuid, file_id: uuid::Uuid, sha256: &str) -> String {
    let suffix = sha256.get(0..16).unwrap_or("unknown");
    format!("users/{user_id}/files/{file_id}-{suffix}")
}
