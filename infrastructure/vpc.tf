# VPC for the ECS Fargate API (knowable-api).
#
# Isolated from any other Knowable infrastructure (which is otherwise all
# serverless and lives in default VPCs/AWS-managed networking). Shape:
#
#   - 10.10.0.0/16
#   - 2 public subnets (10.10.0.0/24, 10.10.1.0/24)  →  ALB lives here
#   - 2 private subnets (10.10.10.0/24, 10.10.11.0/24) → Fargate tasks here
#   - 1 Internet Gateway
#   - 1 NAT Gateway in public[0] (cost optimization — single AZ NAT, ~$32/mo).
#     If AZ-a's NAT fails, private[1] task egress breaks until NAT recovers.
#     Acceptable tradeoff at our scale vs. ~$32/mo extra for dual NAT.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "api" {
  cidr_block           = "10.10.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "knowable-api-vpc" }
}

resource "aws_subnet" "api_public" {
  count                   = 2
  vpc_id                  = aws_vpc.api.id
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  cidr_block              = "10.10.${count.index}.0/24"
  map_public_ip_on_launch = true

  tags = { Name = "knowable-api-public-${count.index}" }
}

resource "aws_subnet" "api_private" {
  count             = 2
  vpc_id            = aws_vpc.api.id
  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = "10.10.${10 + count.index}.0/24"

  tags = { Name = "knowable-api-private-${count.index}" }
}

resource "aws_internet_gateway" "api" {
  vpc_id = aws_vpc.api.id
  tags   = { Name = "knowable-api-igw" }
}

resource "aws_eip" "api_nat" {
  domain = "vpc"
  tags   = { Name = "knowable-api-nat-eip" }
}

resource "aws_nat_gateway" "api" {
  allocation_id = aws_eip.api_nat.id
  subnet_id     = aws_subnet.api_public[0].id
  tags          = { Name = "knowable-api-nat" }
  depends_on    = [aws_internet_gateway.api]
}

resource "aws_route_table" "api_public" {
  vpc_id = aws_vpc.api.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.api.id
  }

  tags = { Name = "knowable-api-public-rt" }
}

resource "aws_route_table" "api_private" {
  vpc_id = aws_vpc.api.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.api.id
  }

  tags = { Name = "knowable-api-private-rt" }
}

resource "aws_route_table_association" "api_public" {
  count          = 2
  subnet_id      = aws_subnet.api_public[count.index].id
  route_table_id = aws_route_table.api_public.id
}

resource "aws_route_table_association" "api_private" {
  count          = 2
  subnet_id      = aws_subnet.api_private[count.index].id
  route_table_id = aws_route_table.api_private.id
}

# ---- Security groups ----

# ALB faces the world on :443 (and :80 for redirect). The ALB reaches
# Fargate tasks on :3000 via the ecs_task SG below.
resource "aws_security_group" "alb" {
  name        = "knowable-api-alb-sg"
  description = "ALB ingress: 443/tcp + 80/tcp from anywhere; egress unrestricted to tasks."
  vpc_id      = aws_vpc.api.id

  ingress {
    description      = "HTTPS from the world"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTP (redirected to HTTPS by the listener)"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Fargate tasks: inbound only from the ALB on :3000. Egress unrestricted
# so they can reach Bedrock, ElevenLabs, DynamoDB, S3 via the NAT.
resource "aws_security_group" "ecs_task" {
  name        = "knowable-api-task-sg"
  description = "Fargate task ingress: 3000/tcp from ALB only."
  vpc_id      = aws_vpc.api.id

  ingress {
    description     = "App port from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
