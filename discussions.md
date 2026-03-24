### Functional Requirements

My Requirements

1. user should be able to request for a short url given long url
2. user should be able to click short url and redirected to long url.
3. user should be able to invalidate short url
4. user should see click rates for each short url that he created.

*Neetcode → almost similar*

*Hello interview →* 

1. *user should be able to optionally specify custom alias for their shortened url*

### Non-Functional Requirements

Focus on CAP

My Nfr

1. system should support total of 1B  url creation mappings → scalability
2. system should support 100 million url redirections per day → scalability
3. Prefer availability over strong consistency. 99.99%

Neetcode

- each url must be unique
- system must respond with minimal delay ideally under few milliseconds
- prevent malicious links creation, protect user data and implement safeguard agains spam.

HelloInterview

- redirection delay needs to be less than 100ms
- system should support 1B urls per day and 100M DAU

### Core Entities

- Users
- Urls

Neetcode → Data model

- Urls
- Analytics

HelloInterview → core entities and suggest to focus on actual columns at a later point, but let your interviewer know about it.

- Original Url
- Short url
- User

### APIs

- create url → POST  /url  body→ { long_url: string, custom_alias: string } returns {short_url: string}
- redirection → GET /{shortened_url} → redirect the user
- delete → DELETE /url/{id} → authenticates and invalidates url
- analytics → GET /url/{id} → {clicks: number, last_accessed: date}

Neetcode

POST  api/urls/shorten → gets short url

GET api/urls/{shortUrl} → returns long url which client can use to redirect.

Hellointerview

- create url should also support expiration_date;
- redirect needs to happen automatically without get endpoint returning the url (suggests that we will talk about response http code at later point)

### High Level Design

![Interview.jpg](attachment:2353b6aa-6c8c-4c14-ac9f-801361905114:Interview.jpg)

Neetcode

- used nosql database suggests dynamodb or cassandra but i think postgres should suffice
- get sends 302 header with a location tag with original url which helps client in redirection
- suggest using read-through cache.
- adds another tracking service which stores count in memeory db and periodically flush to redis.
- use machine id plus counter for id generation. the use base-62 encoding to get the final url

Hello interview

- use basic validation like checking if url is really a url
- do we already have this url in our db. deduplication but i think we can be okay with it since matching by url is going to be very expensive.
- short url exist at a domain which we own short.ly/url/{code}
- when user sends get request on the short url → check if it exists in db if no send 410 gone.
- else send 301 with appropriate location header.
- add a ttl to cache lower than expiration time such that expired entries are auto evicted.
- 2 types of headers which are useful
    - 301 permanent redirect →browser cache it and then same request does not hit our server. but we may miss click rates
    - 302 found → browser dont cache this and request always hit our server first.
- 302 has many benefits → it gives more control like expiration, click rates

### Deep Dives

storage: 100 million urls per day → long url → 200 bytes, short url →100 bytes total say 300 bytes per row. 

100 m * 300bytes = 3 x 10^10 → 30gb perday

5 * 365 * 30 = 50, 000 GB ⇒ total 100TB of data. user data coulbe say 10million 

indexing on short_code field → db query faster

Hello interview

generating short code 2 options

1. random hashing and then encoding with base 62. with unique constraint on shortcode column. if collision occur retry.
2. counter then encode so that no collisions occur. use redis as a distributed counter.
    1. redis is right option for counter it is atomic and fast.
3. typical ssd support 100000 iops but the volume at which we are operating is still not enough even with indexing so we will need caching.
4. say we are operating at 100 million DAU  and on average each user doing 5 redirects then it is 5787 rps. (on average but it may peak higher)
5. ideally we do 100x spike so that would be around 600,000 read ops per second. db would not be able to handle this or it may time out and affect other operations.
6. then we use caching. specifically set-aside caching; few number
    1. memory access time - 100ns
    2. ssd access time - 0.1ms
    3. hdd - 10 ms
    4. 1000x faster than sse and 100,000 faster than hdd
    
    In terms of iops
    
    - redis/in memory can support millions of reads per second
    - ssd support 100,000 reads
    - hdd: 100-200 iops
- Important factors when caching - eviction policy and TTL

Another solution is to use cdns for redirection. here short url domain is served via cdn. by deploying redirect logic closer to user using plarforms like cloudflare workers or aws lambda@edge we can improve performance without loading primary server.

- But here as well invalidation is complex.
- cost may run high
- workers support minimal libraries so redirection logic needs to be carefully crafted.

Scaling to 1B urls and 100m users

- each row
    - short url - 8 bytes
    - long url - 100 bytes
    - time - 8 bytes
    - custom alias - 100 bytes
    - round up to say 500 bytes per row
- that will be 500 Gb data in toal but postgres single instance can handle this.
- we esitmate that 100k new urls are generated per day so that is 1rps so post endpoint is fine and may not need complex scaling.
- another important point is having separate service for creation and redirection as they have different scaling needs.

What if Db goes down?

- Database replication - postgres support replication but this adds additional complexity
- Database backup - periodic snapshot of db.

We esitmated that write throughput is low and we have higher read throughput. so both services have different scaling needs.

Read service needs high scalability. but redis being single threaded can act as global counter  and support counts across the instances.

To ensure high availability we can use Redis sentinel or Redis cluster with automatic failover.

for multi region deployements allocate disjoint ranges to each region inorder to avoid ross region coordination.

Another point is redis gives each instance a batch of counts it can use for eg (1000 to 2000). when count is exhausted instance can ask for new entries. 

Still what if redis goes down?
- Enable high availability with replication for recovery.
- Also redis has AOF and RDB which can be used to restart.

Another nicer solution was to use (url + time) to get the hash and then base 62 encode the result which is your short code.