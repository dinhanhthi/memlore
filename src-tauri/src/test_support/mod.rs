pub mod mock_app;

/// Compile-probe for the `rmcp` crate (Task 1.1). Server, tools, and
/// transports land in later tasks — this only asserts the crate links.
#[test]
fn rmcp_crate_is_linked() {
    let _ = std::any::type_name::<rmcp::RoleServer>();
}
