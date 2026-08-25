# Depot — Site Requirements

One page. Everything on it must be true before installation day. Your ParaTech
contact walks through each item with you during the site survey.

## What your site provides

| # | Requirement | Details |
|---|-------------|---------|
| 1 | **Static public IP** | From your internet provider, on the connection Depot will use. Dynamic or CGNAT connections do not qualify. |
| 2 | **Router port-forward** | TCP **80** and **443** forwarded to the Depot VM. Port 80 must be reachable from the internet (certificates fail without it — we test this, not just the checkbox). |
| 3 | **One DNS record** | A single A record in your domain's DNS (for example `docs.yourcompany.com`) pointing at the static IP, TTL 300. Set once; we never need your registrar again. Exactly one hostname — no `www.` variant. |
| 4 | **A virtual machine** | On your hypervisor (ESXi, Proxmox, or Hyper-V): blank **Ubuntu Server 26.04 LTS**, **4 vCPU / 8 GB RAM / 250 GB disk** (thin-provisioned is fine), bridged to a LAN segment that can reach the internet. Console or SSH access for installation day. |
| 5 | **Microsoft 365 admin** *(if using 365 features)* | A Global Administrator available for one ~45-minute session to authorize Depot in your own tenant (email notifications, SharePoint access). Depot gets its own scoped app registration — no shared vendor credential. |
| 6 | **Hairpin NAT or internal DNS** | Devices inside your office must be able to reach `docs.yourcompany.com`. Most routers handle this ("hairpin NAT"); where yours doesn't, your internal DNS needs one matching record. We test this during the survey. |

## What ParaTech provides and manages

- Installation, licensing, and configuration of the Depot software on your VM.
- HTTPS certificates — issued and renewed automatically; no action on your side.
- Updates — tested on our own systems first, then applied in your agreed
  maintenance window.
- Monitoring — health, disk, backups, and certificates are watched from our
  management tooling; we usually know before you do.
- Backups — a nightly application backup on the VM, carried offsite by the
  ParaTech BCDR service (Axcient) with the rest of the machine image.
- Management access rides a private overlay network (Tailscale) — **no inbound
  admin ports** are opened at your site, ever.

## Responsibilities split

| Yours | Ours |
|-------|------|
| The hypervisor, its host hardware, power, and internet service | Everything inside the VM |
| Keeping the static IP and port-forwards in place | Detecting and flagging when they change |
| The DNS record (set once) | Everything that depends on it |
| Naming a customer admin (first login + password) | All other accounts, updates, restores |

## Sign-off

| | |
|---|---|
| Customer | ____________________  date ________ |
| ParaTech | ____________________  date ________ |
| Domain to use | ____________________ |
| Static IP | ____________________ |
| Maintenance window | ____________________ |
