// Supabase project credentials. The publishable key is safe for browser use;
// database access must still be restricted with Row Level Security policies.
const SUPABASE_URL = "https://zmecglsacojnyixucjar.supabase.co";
const SUPABASE_KEY = "sb_publishable_s-t69w0R8z5bZlJe8AIa5g_lpStwER2";
let communityConnectClient = null;
let supabaseLoadError = null;

try {
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    throw new Error("The Supabase JavaScript library did not load.");
  }
  communityConnectClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (error) {
  supabaseLoadError = error;
}

const state = {
  user: null,
  profile: null,
  resources: [],
  authMode: "login",
  toastTimer: null,
  requestChannel: null,
  requestPollTimer: null,
  ownerRequestStatuses: new Map()
};

const categoryIcons = {
  "Tools": "🛠️",
  "Home & Garden": "🪴",
  "Books & Learning": "📚",
  "Electronics": "🔌",
  "Sports & Outdoors": "🚲",
  "Other": "✨"
};

const elements = {};

document.addEventListener("DOMContentLoaded", initializeApp);

function initializeApp() {
  [
    "auth-screen", "app", "auth-form", "auth-name", "auth-email", "auth-password",
    "name-field", "auth-name-label", "auth-heading", "auth-subheading", "auth-submit", "auth-message",
    "login-tab", "signup-tab", "logout-button", "nav-user", "nav-toggle", "nav-links",
    "share-form", "share-name", "share-submit", "share-message", "resource-list",
    "share-image", "share-image-preview", "resource-empty", "resource-search", "category-filter", "requests-list",
    "requests-empty", "my-requests-list", "my-requests-empty", "refresh-requests", "resource-dialog", "dialog-content",
    "dialog-close", "toast", "footer-year"
  ].forEach((id) => {
    const propertyName = id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    elements[propertyName] = document.getElementById(id);
  });

  elements.footerYear.textContent = String(new Date().getFullYear());
  bindEvents();
  setAuthMode("signup");

  if (!communityConnectClient) {
    setFormMessage(
      elements.authMessage,
      "The sign-in service could not load. Check your internet connection and reload this page.",
      "error"
    );
    return;
  }

  // Defer Supabase work until after the auth callback returns.
  communityConnectClient.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => { handleSession(session); }, 0);
  });

  checkExistingSession();
}

function bindEvents() {
  elements.loginTab.addEventListener("click", () => setAuthMode("login"));
  elements.signupTab.addEventListener("click", () => setAuthMode("signup"));
  elements.authForm.addEventListener("submit", handleAuthSubmit);
  elements.logoutButton.addEventListener("click", handleSignOut);
  elements.shareForm.addEventListener("submit", handleShareSubmit);
  elements.shareImage.addEventListener("change", previewResourceImage);
  elements.resourceSearch.addEventListener("input", renderResources);
  elements.categoryFilter.addEventListener("change", renderResources);
  elements.refreshRequests.addEventListener("click", refreshRequestLists);
  elements.navToggle.addEventListener("click", toggleNavigation);
  elements.navLinks.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeNavigation();
  });
  elements.dialogClose.addEventListener("click", () => elements.resourceDialog.close());
  elements.resourceDialog.addEventListener("click", (event) => {
    if (event.target === elements.resourceDialog) elements.resourceDialog.close();
  });
}

async function checkExistingSession() {
  const { data, error } = await communityConnectClient.auth.getSession();
  if (error) {
    showToast(`Could not check your session: ${error.message}`, "error");
    return;
  }
  await handleSession(data.session);
}

async function handleSession(session) {
  if (!session) {
    if (state.requestChannel) {
      communityConnectClient.removeChannel(state.requestChannel);
      state.requestChannel = null;
    }
    if (state.requestPollTimer) {
      window.clearInterval(state.requestPollTimer);
      state.requestPollTimer = null;
    }
    state.ownerRequestStatuses.clear();
    state.user = null;
    state.profile = null;
    elements.app.classList.add("hidden");
    elements.authScreen.classList.remove("hidden");
    return;
  }

  const isSameUser = state.user && state.user.id === session.user.id;
  state.user = session.user;
  subscribeToRequestUpdates(session.user.id);
  startRequestNotificationPolling(session.user.id);
  elements.authScreen.classList.add("hidden");
  elements.app.classList.remove("hidden");
  if (window.location.hash !== "#resources") {
    window.location.hash = "resources";
  }

  if (!isSameUser) {
    await ensureProfile();
    setUserLabels();
    await Promise.all([loadResources(), loadOwnerRequests(), loadMyRequests()]);
  }
}

async function ensureProfile() {
  if (!state.user) return;

  const metadataName = state.user.user_metadata && state.user.user_metadata.name;
  const fallbackName = metadataName || (state.user.email ? state.user.email.split("@")[0] : "Neighbor");
  const { data: existingProfile, error: selectError } = await communityConnectClient
    .from("profiles")
    .select("id, name, location")
    .eq("id", state.user.id)
    .maybeSingle();

  if (selectError) {
    showToast(`Could not load your profile: ${selectError.message}`, "error");
    state.profile = { id: state.user.id, name: fallbackName, location: "" };
    return;
  }

  if (existingProfile) {
    state.profile = existingProfile;
    return;
  }

  const { data: insertedProfile, error: insertError } = await communityConnectClient
    .from("profiles")
    .insert({ id: state.user.id, name: fallbackName, location: "" })
    .select("id, name, location")
    .single();

  if (insertError) {
    showToast(`Your account is signed in, but your profile could not be saved: ${insertError.message}`, "error");
    state.profile = { id: state.user.id, name: fallbackName, location: "" };
    return;
  }
  state.profile = insertedProfile;
}

function setUserLabels() {
  const name = state.profile && state.profile.name
    ? state.profile.name
    : (state.user && state.user.email ? state.user.email : "Neighbor");
  elements.navUser.textContent = `Hi, ${name}`;
  if (elements.shareName && !elements.shareName.value) {
    elements.shareName.value = name;
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === "signup";
  elements.nameField.classList.remove("hidden");
  elements.authName.required = signup;
  elements.authNameLabel.textContent = signup ? "Your name" : "Your name (optional)";
  elements.authName.placeholder = signup ? "e.g. Jordan Lee" : "Enter your name to update your profile";
  elements.authPassword.autocomplete = signup ? "new-password" : "current-password";
  elements.authHeading.textContent = signup ? "Join your community" : "Welcome back";
  elements.authSubheading.textContent = signup
    ? "Create an account to share and discover resources."
    : "Sign in to see what your neighbors are sharing.";
  elements.authSubmit.textContent = signup ? "Create account" : "Sign in";
  elements.loginTab.classList.toggle("active", !signup);
  elements.signupTab.classList.toggle("active", signup);
  elements.loginTab.setAttribute("aria-selected", String(!signup));
  elements.signupTab.setAttribute("aria-selected", String(signup));
  setFormMessage(elements.authMessage, "");
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const email = elements.authEmail.value.trim();
  const password = elements.authPassword.value;
  const name = elements.authName.value.trim();
  setButtonBusy(elements.authSubmit, true, state.authMode === "signup" ? "Creating account…" : "Signing in…");
  setFormMessage(elements.authMessage, "");

  try {
    if (!communityConnectClient) {
      const detail = supabaseLoadError && supabaseLoadError.message;
      throw new Error(detail || "The sign-in service is unavailable. Reload the page and try again.");
    }

    if (state.authMode === "signup") {
      if (!name) throw new Error("Please enter your name.");
      const { data, error } = await communityConnectClient.auth.signUp({
        email,
        password,
        options: { data: { name } }
      });
      if (error) throw error;

      if (data.session && data.user) {
        showToast("Your account is ready. Welcome to the community!", "success");
        await handleSession(data.session);
      } else {
        setFormMessage(elements.authMessage, "Account created and your profile saved. Check your email to confirm your address, then sign in.", "success");
        elements.authPassword.value = "";
      }
    } else {
      const { data, error } = await communityConnectClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) {
        throw new Error("Sign-in returned no session. Check that this account's email is confirmed, then try again.");
      }
      await handleSession(data.session);
      if (name) {
        const { data: profile, error: profileError } = await communityConnectClient
          .from("profiles")
          .update({ name })
          .eq("id", data.user.id)
          .select("id, name, location")
          .maybeSingle();
        if (profileError) {
          showToast(`Signed in, but your profile name could not be updated: ${profileError.message}`, "error");
        } else if (profile) {
          state.profile = profile;
          setUserLabels();
        }
      }
      showToast("Welcome back!", "success");
    }
  } catch (error) {
    setFormMessage(elements.authMessage, getAuthErrorMessage(error), "error");
  } finally {
    setButtonBusy(elements.authSubmit, false);
  }
}

function getAuthErrorMessage(error) {
  const message = error && error.message ? error.message : "";
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes("invalid login credentials")) {
    return "Email or password is incorrect. If you just created an account, confirm your email first, then sign in.";
  }
  if (normalizedMessage.includes("email not confirmed")) {
    return "Please confirm your email using the link Supabase sent you, then sign in.";
  }
  if (normalizedMessage.includes("failed to fetch") || normalizedMessage.includes("fetch")) {
    return "Could not connect to Supabase. Check your internet connection and Supabase project URL, then try again.";
  }
  return message || "Something went wrong. Please try again.";
}

async function handleSignOut() {
  const { error } = await communityConnectClient.auth.signOut();
  if (error) {
    showToast(`Could not sign out: ${error.message}`, "error");
    return;
  }
  state.user = null;
  state.profile = null;
  elements.authForm.reset();
  setAuthMode("login");
  showToast("You’ve signed out.", "success");
}

async function handleShareSubmit(event) {
  event.preventDefault();
  setButtonBusy(elements.shareSubmit, true, "Sharing…");
  setFormMessage(elements.shareMessage, "");

  try {
    const { data: { user }, error: userError } = await communityConnectClient.auth.getUser();
    if (userError) throw userError;
    if (!user) throw new Error("Please sign in before sharing a resource.");

    const name = elements.shareName.value.trim();
    const resourceName = document.getElementById("share-resource-name").value.trim();
    const category = document.getElementById("share-category").value;
    const location = document.getElementById("share-location").value.trim();
    const description = document.getElementById("share-description").value.trim();
    const image = elements.shareImage.files && elements.shareImage.files[0];
    validateResourceImage(image);

    const extension = image.name.split(".").pop().toLowerCase();
    const imagePath = `${user.id}/${createUniqueId()}.${extension}`;
    const { error: uploadError } = await communityConnectClient.storage
      .from("resource-images")
      .upload(imagePath, image, {
        cacheControl: "3600",
        contentType: image.type,
        upsert: false
      });
    if (uploadError) throw uploadError;

    const { data: publicImage } = communityConnectClient.storage
      .from("resource-images")
      .getPublicUrl(imagePath);

    const { error: insertError } = await communityConnectClient.from("resources").insert({
      user_id: user.id,
      owner_name: name,
      resource_name: resourceName,
      category,
      location,
      description,
      image_url: publicImage.publicUrl,
      image_path: imagePath,
      status: "Available"
    });
    if (insertError) {
      const { error: cleanupError } = await communityConnectClient.storage
        .from("resource-images")
        .remove([imagePath]);
      if (cleanupError) {
        throw new Error(`The resource could not be saved (${insertError.message}), and its uploaded photo could not be cleaned up (${cleanupError.message}).`);
      }
      throw insertError;
    }

    elements.shareForm.reset();
    clearImagePreview();
    setUserLabels();
    setFormMessage(elements.shareMessage, "Your resource is on the community board. Thanks for sharing!", "success");
    showToast("Resource shared successfully.", "success");
    await loadResources();
  } catch (error) {
    setFormMessage(elements.shareMessage, error.message || "Could not share this resource.", "error");
  } finally {
    setButtonBusy(elements.shareSubmit, false);
  }
}

async function loadResources() {
  const { data, error } = await communityConnectClient
    .from("resources")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    showToast(`Could not load resources: ${error.message}`, "error");
    elements.resourceList.replaceChildren();
    elements.resourceEmpty.classList.remove("hidden");
    return;
  }

  state.resources = (data || []).map((resource) => ({
    ...resource,
    owner: resource.owner_name,
    name: resource.resource_name
  }));
  renderResources();
}

function renderResources() {
  const query = elements.resourceSearch.value.trim().toLowerCase();
  const category = elements.categoryFilter.value;
  const visibleResources = state.resources.filter((resource) => {
    const searchable = [
      resource.name, resource.category, resource.description,
      resource.location, resource.owner
    ].filter(Boolean).join(" ").toLowerCase();
    return (!query || searchable.includes(query))
      && (category === "all" || resource.category === category);
  });

  elements.resourceList.replaceChildren();
  elements.resourceEmpty.classList.toggle("hidden", visibleResources.length > 0);
  visibleResources.forEach((resource) => elements.resourceList.append(createResourceCard(resource)));
}

function createResourceCard(resource) {
  const card = document.createElement("article");
  card.className = "resource-card";

  if (resource.image_url) {
    const photo = document.createElement("img");
    photo.className = "resource-photo";
    photo.src = resource.image_url;
    photo.alt = `${resource.name || "Shared resource"} photo`;
    photo.loading = "lazy";
    photo.addEventListener("error", () => photo.classList.add("image-load-failed"), { once: true });
    card.append(photo);
  }

  const top = document.createElement("div");
  top.className = "resource-card-top";
  const icon = document.createElement("span");
  icon.className = "resource-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = categoryIcons[resource.category] || categoryIcons.Other;
  top.append(icon, createStatusBadge(resource.status));

  const category = document.createElement("span");
  category.className = "resource-category";
  category.textContent = resource.category || "Other";
  const title = document.createElement("h3");
  title.textContent = resource.name || "Untitled resource";
  const description = document.createElement("p");
  description.className = "resource-description";
  description.textContent = resource.description || "No description provided.";
  const meta = document.createElement("div");
  meta.className = "resource-meta";
  meta.append(
    makeTextElement("span", `⌖ ${resource.location || "Location not provided"}`),
    makeTextElement("span", `◷ ${formatDate(resource.created_at)}`)
  );

  const footer = document.createElement("div");
  footer.className = "resource-card-footer";
  const owner = document.createElement("span");
  owner.className = "resource-owner";
  owner.textContent = `Shared by ${resource.owner || "Neighbor"}`;
  const actions = document.createElement("div");
  actions.className = "resource-actions";
  const detailsButton = makeButton("Details", "text-button");
  detailsButton.addEventListener("click", () => openResourceDetails(resource));
  actions.append(detailsButton);

  const isOwner = Boolean(state.user && resource.user_id === state.user.id);
  if (isOwner) {
    const deleteButton = makeButton("Remove", "text-button danger");
    deleteButton.setAttribute("aria-label", `Remove ${resource.name || "resource"}`);
    deleteButton.addEventListener("click", () => deleteResource(resource.id));
    actions.append(deleteButton);
  } else if (resource.status === "Available") {
    const requestButton = makeButton("Request", "text-button");
    requestButton.addEventListener("click", () => requestResource(resource));
    actions.append(requestButton);
  }
  footer.append(owner, actions);
  card.append(top, category, title, description, meta, footer);
  return card;
}

async function requestResource(resource) {
  try {
    const { data: { user }, error: userError } = await communityConnectClient.auth.getUser();
    if (userError) throw userError;
    if (!user) throw new Error("Please sign in to request a resource.");
    if (resource.user_id === user.id) throw new Error("You can’t request your own resource.");

    const userName = state.profile && state.profile.name
      ? state.profile.name
      : (user.user_metadata && user.user_metadata.name) || (user.email ? user.email.split("@")[0] : "Neighbor");
    const { error } = await communityConnectClient.from("requests").insert({
      resource_id: resource.id,
      requester_id: user.id,
      requester_name: userName,
      status: "Pending"
    });
    if (error) throw error;
    showToast(`Request sent for ${resource.name}.`, "success");
  } catch (error) {
    showToast(error.message || "Could not send your request.", "error");
  }
}

async function loadOwnerRequests() {
  if (!state.user) {
    elements.requestsList.replaceChildren();
    elements.requestsEmpty.classList.remove("hidden");
    return;
  }

  const { data: ownedResources, error: resourcesError } = await communityConnectClient
    .from("resources")
    .select("id, resource_name")
    .eq("user_id", state.user.id);
  if (resourcesError) {
    showToast(`Could not load your resources: ${resourcesError.message}`, "error");
    return;
  }

  const resourceIds = (ownedResources || []).map((resource) => resource.id);
  if (resourceIds.length === 0) {
    renderOwnerRequests([], new Map());
    return;
  }

  const { data: requests, error: requestsError } = await communityConnectClient
    .from("requests")
    .select("*")
    .in("resource_id", resourceIds)
    .order("created_at", { ascending: false });
  if (requestsError) {
    showToast(`Could not load resource requests: ${requestsError.message}`, "error");
    return;
  }

  notifyForReturnedRequests(requests || []);
  const resourceNames = new Map((ownedResources || []).map((resource) => [String(resource.id), resource.resource_name]));
  renderOwnerRequests(requests || [], resourceNames);
}

async function loadMyRequests() {
  if (!state.user) {
    elements.myRequestsList.replaceChildren();
    elements.myRequestsEmpty.classList.remove("hidden");
    return;
  }

  const { data: requests, error } = await communityConnectClient
    .from("requests")
    .select("*")
    .eq("requester_id", state.user.id)
    .order("created_at", { ascending: false });
  if (error) {
    showToast(`Could not load your requests: ${error.message}`, "error");
    return;
  }

  const resourceIds = [...new Set((requests || []).map((request) => request.resource_id))];
  let resourcesById = new Map();
  if (resourceIds.length) {
    const { data: resources, error: resourcesError } = await communityConnectClient
      .from("resources")
      .select("id, resource_name, owner_name, location")
      .in("id", resourceIds);
    if (resourcesError) {
      showToast(`Could not load requested item details: ${resourcesError.message}`, "error");
      return;
    }
    resourcesById = new Map((resources || []).map((resource) => [String(resource.id), resource]));
  }

  renderMyRequests(requests || [], resourcesById);
}

async function refreshRequestLists() {
  await Promise.all([loadOwnerRequests(), loadMyRequests()]);
}

function subscribeToRequestUpdates(userId) {
  if (state.requestChannel) {
    communityConnectClient.removeChannel(state.requestChannel);
  }

  state.requestChannel = communityConnectClient
    .channel(`communityconnect-requests-${userId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "requests" },
      async (payload) => {
        if (!payload.new || payload.new.status !== "Returned" || state.user?.id !== userId) return;

        const { data: ownedResource, error } = await communityConnectClient
          .from("resources")
          .select("resource_name")
          .eq("id", payload.new.resource_id)
          .eq("user_id", userId)
          .maybeSingle();

        if (error) {
          showToast(`A return was recorded, but its notification could not be verified: ${error.message}`, "error");
          return;
        }
        if (!ownedResource) return;

        const requester = payload.new.requester_name || "A neighbor";
        state.ownerRequestStatuses.set(String(payload.new.id), "Returned");
        showToast(`${requester} returned ${ownedResource.resource_name}.`, "success");
        await Promise.all([loadResources(), loadOwnerRequests()]);
      }
    )
    .subscribe((status, error) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        showToast(`Live return notifications are unavailable${error ? `: ${error.message}` : "."}`, "error");
      }
    });
}

function startRequestNotificationPolling(userId) {
  if (state.requestPollTimer) {
    window.clearInterval(state.requestPollTimer);
  }
  state.requestPollTimer = window.setInterval(() => {
    if (state.user && state.user.id === userId) {
      loadOwnerRequests();
    }
  }, 15000);
}

function notifyForReturnedRequests(requests) {
  requests.forEach((request) => {
    const requestId = String(request.id);
    const previousStatus = state.ownerRequestStatuses.get(requestId);
    if (previousStatus === "Approved" && request.status === "Returned") {
      showToast(`${request.requester_name || "A neighbor"} returned an item you shared.`, "success");
    }
    state.ownerRequestStatuses.set(requestId, request.status);
  });
}

function renderMyRequests(requests, resourcesById) {
  elements.myRequestsList.replaceChildren();
  const visibleRequests = requests.filter((request) => request.status !== "Cancelled");
  elements.myRequestsEmpty.classList.toggle("hidden", visibleRequests.length > 0);

  visibleRequests.forEach((request) => {
    const resource = resourcesById.get(String(request.resource_id));
    const row = document.createElement("article");
    row.className = "request-row my-request-row";

    const primary = document.createElement("div");
    primary.className = "request-primary";
    const resourceName = document.createElement("strong");
    resourceName.textContent = resource ? resource.resource_name : "Shared item";
    const detail = document.createElement("small");
    detail.textContent = resource
      ? `Shared by ${resource.owner_name || "Neighbor"} · ${resource.location || "Location not provided"}`
      : "The resource may have been removed.";
    primary.append(resourceName, detail);

    const status = document.createElement("span");
    status.className = `request-status ${(request.status || "Pending").toLowerCase()}`;
    status.textContent = request.status || "Pending";
    const statusActions = document.createElement("div");
    statusActions.className = "request-status-actions";
    if (request.status === "Approved" && resource) {
      const returnButton = makeButton("Return item", "button button-primary");
      returnButton.addEventListener("click", () => returnRequestedResource(request));
      statusActions.append(status, returnButton);
    } else {
      statusActions.append(status);
    }
    if (request.status !== "Approved") {
      const deleteButton = makeButton("Delete", "button button-outline");
      deleteButton.addEventListener("click", () => deleteOwnRequest(request));
      statusActions.append(deleteButton);
    }
    row.append(primary, statusActions);
    elements.myRequestsList.append(row);
  });
}

async function deleteOwnRequest(request) {
  if (!window.confirm("Delete this request from your request history?")) return;

  const { data: deletedRequest, error } = await communityConnectClient
    .from("requests")
    .delete()
    .eq("id", request.id)
    .eq("requester_id", state.user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    showToast(`Could not delete your request: ${error.message}`, "error");
    return;
  }
  if (!deletedRequest) {
    showToast("This request was not deleted. Approved items must be marked returned first.", "error");
    return;
  }

  showToast("Request deleted.", "success");
  await loadMyRequests();
}

async function returnRequestedResource(request) {
  const { error } = await communityConnectClient.rpc("return_requested_resource", {
    request_id: request.id
  });
  if (error) {
    showToast(`Could not return this item: ${error.message}`, "error");
    return;
  }

  showToast("Item marked returned and is available again.", "success");
  await Promise.all([loadResources(), loadMyRequests(), loadOwnerRequests()]);
}

function renderOwnerRequests(requests, resourceNames) {
  elements.requestsList.replaceChildren();
  const visibleRequests = requests.filter((request) => request.status !== "Cancelled");
  elements.requestsEmpty.classList.toggle("hidden", visibleRequests.length > 0);

  visibleRequests.forEach((request) => {
    const row = document.createElement("article");
    row.className = "request-row";
    const primary = document.createElement("div");
    primary.className = "request-primary";
    const requester = document.createElement("strong");
    requester.textContent = request.requester_name || "Community member";
    const resourceName = document.createElement("small");
    resourceName.textContent = `Requested: ${resourceNames.get(String(request.resource_id)) || "Your resource"}`;
    primary.append(requester, resourceName);

    const status = document.createElement("span");
    status.className = `request-status ${(request.status || "Pending").toLowerCase()}`;
    status.textContent = request.status || "Pending";
    const actions = document.createElement("div");
    actions.className = "request-actions";
    if (request.status === "Pending") {
      const approve = makeButton("Approve", "button button-primary");
      approve.addEventListener("click", () => updateRequestStatus(request, "Approved"));
      const reject = makeButton("Reject", "button button-outline");
      reject.addEventListener("click", () => updateRequestStatus(request, "Rejected"));
      actions.append(approve, reject);
    }
    row.append(primary, status, actions);
    elements.requestsList.append(row);
  });
}

async function updateRequestStatus(request, status) {
  const { data: updatedRequest, error } = await communityConnectClient
    .from("requests")
    .update({ status })
    .eq("id", request.id)
    .select("id")
    .maybeSingle();
  if (error) {
    showToast(`Could not ${status.toLowerCase()} this request: ${error.message}`, "error");
    return;
  }
  if (!updatedRequest) {
    showToast("This request could not be updated. Check the requests update policy.", "error");
    return;
  }

  if (status === "Approved") {
    const { data: updatedResource, error: resourceError } = await communityConnectClient
      .from("resources")
      .update({ status: "Taken" })
      .eq("id", request.resource_id)
      .eq("user_id", state.user.id)
      .select("id")
      .maybeSingle();
    if (resourceError || !updatedResource) {
      showToast(`The request was approved, but the resource could not be marked Taken${resourceError ? `: ${resourceError.message}` : ". Check the resources update policy."}`, "error");
      await loadOwnerRequests();
      return;
    }
    await loadResources();
  }
  showToast(`Request ${status.toLowerCase()}.`, "success");
  await Promise.all([loadOwnerRequests(), loadMyRequests()]);
}

async function deleteResource(resourceId) {
  const resource = state.resources.find((item) => item.id === resourceId);
  const resourceName = resource ? resource.name : "this resource";
  if (!window.confirm(`Remove "${resourceName}" from the community board?`)) return;

  const { data: deletedResource, error } = await communityConnectClient
    .from("resources")
    .delete()
    .eq("id", resourceId)
    .eq("user_id", state.user.id)
    .select("id, image_path")
    .maybeSingle();
  if (error) {
    showToast(`Could not remove this resource: ${error.message}`, "error");
    return;
  }
  if (!deletedResource) {
    showToast("This resource was not removed. Check the resources delete policy.", "error");
    return;
  }
  if (deletedResource.image_path) {
    const { error: imageError } = await communityConnectClient.storage
      .from("resource-images")
      .remove([deletedResource.image_path]);
    if (imageError) {
      showToast(`Resource removed, but its photo could not be deleted: ${imageError.message}`, "error");
      await Promise.all([loadResources(), loadOwnerRequests(), loadMyRequests()]);
      return;
    }
  }
  showToast("Resource removed.", "success");
  await Promise.all([loadResources(), loadOwnerRequests(), loadMyRequests()]);
}

function openResourceDetails(resource) {
  const content = elements.dialogContent;
  content.replaceChildren();

  const icon = document.createElement("span");
  icon.className = "dialog-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = categoryIcons[resource.category] || categoryIcons.Other;
  if (resource.image_url) {
    const photo = document.createElement("img");
    photo.className = "dialog-resource-photo";
    photo.src = resource.image_url;
    photo.alt = `${resource.name || "Shared resource"} photo`;
    content.append(photo);
  }
  const category = makeTextElement("span", resource.category || "Other");
  category.className = "dialog-category";
  const title = makeTextElement("h2", resource.name || "Untitled resource");
  title.id = "dialog-title";
  const description = makeTextElement("p", resource.description || "No description provided.");
  description.className = "dialog-description";
  const details = document.createElement("div");
  details.className = "dialog-details";
  details.append(
    makeTextElement("span", `⌖ Location: ${resource.location || "Not provided"}`),
    makeTextElement("span", `Shared by: ${resource.owner || "Neighbor"}`),
    makeTextElement("span", `Status: ${resource.status || "Available"}`),
    makeTextElement("span", `Shared: ${formatDate(resource.created_at)}`)
  );
  content.append(icon, category, title, description, details);
  elements.resourceDialog.showModal();
}

function previewResourceImage() {
  const file = elements.shareImage.files && elements.shareImage.files[0];
  if (!file) {
    clearImagePreview();
    return;
  }

  try {
    validateResourceImage(file);
  } catch (error) {
    elements.shareImage.value = "";
    clearImagePreview();
    setFormMessage(elements.shareMessage, error.message, "error");
    return;
  }

  if (elements.shareImagePreview.dataset.objectUrl) {
    URL.revokeObjectURL(elements.shareImagePreview.dataset.objectUrl);
  }
  const objectUrl = URL.createObjectURL(file);
  elements.shareImagePreview.src = objectUrl;
  elements.shareImagePreview.dataset.objectUrl = objectUrl;
  elements.shareImagePreview.classList.remove("hidden");
  setFormMessage(elements.shareMessage, "");
}

function clearImagePreview() {
  const objectUrl = elements.shareImagePreview.dataset.objectUrl;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  elements.shareImagePreview.removeAttribute("src");
  delete elements.shareImagePreview.dataset.objectUrl;
  elements.shareImagePreview.classList.add("hidden");
}

function validateResourceImage(file) {
  if (!file) throw new Error("Please choose a photo of the resource.");
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    throw new Error("Choose a JPG, PNG, or WebP image.");
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error("The image must be 5 MB or smaller.");
  }
}

function createUniqueId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createStatusBadge(status) {
  const badge = document.createElement("span");
  const normalizedStatus = status || "Available";
  badge.className = `status-badge ${normalizedStatus.toLowerCase()}`;
  badge.textContent = normalizedStatus;
  return badge;
}

function makeTextElement(tagName, text) {
  const element = document.createElement(tagName);
  element.textContent = text;
  return element;
}

function makeButton(text, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  return button;
}

function formatDate(dateString) {
  if (!dateString) return "Recently";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function setFormMessage(element, message, type = "") {
  element.textContent = message;
  element.classList.remove("error", "success");
  if (type) element.classList.add(type);
}

function setButtonBusy(button, isBusy, busyText) {
  if (isBusy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
    return;
  }
  button.textContent = button.dataset.originalText || button.textContent;
  button.disabled = false;
  delete button.dataset.originalText;
}

function showToast(message, type = "") {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible ${type}`;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.className = "toast";
  }, 4200);
}

function toggleNavigation() {
  const isOpen = elements.navLinks.classList.toggle("open");
  elements.navToggle.setAttribute("aria-expanded", String(isOpen));
  elements.navToggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
}

function closeNavigation() {
  elements.navLinks.classList.remove("open");
  elements.navToggle.setAttribute("aria-expanded", "false");
  elements.navToggle.setAttribute("aria-label", "Open navigation");
}
