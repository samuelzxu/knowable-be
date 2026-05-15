# Application Load Balancer for the knowable-api ECS service.
#
# Internet-facing in the two public subnets. Idle timeout cranked up to
# 4000s so SSE connections (Bedrock + ElevenLabs multiplexed back to the
# Swift client) don't get severed mid-stream by the default 60s.
#
# Target group is `target_type = "ip"` because Fargate uses awsvpc
# networking — tasks are addressed by IP, not instance.

resource "aws_lb" "api" {
  name               = "knowable-api"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.api_public[*].id
  ip_address_type    = "ipv4"

  # SSE-friendly. The Bedrock reasoning loop can hold a connection open
  # for tens of seconds while events stream out; default 60s would cut
  # hints mid-stream. Matches the Kanu reference pattern.
  idle_timeout = 4000

  # Protects against `terraform destroy` mishaps and accidental console
  # deletion. To intentionally remove, flip this back to false and apply
  # before the destroy.
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "api" {
  name        = "knowable-api-tg"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.api.id

  # Speed up rolling deploys — default 300s leaves drained tasks alive
  # for longer than necessary.
  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 3
  }
}

# HTTP → HTTPS redirect. Never serve plaintext.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# Real traffic terminates here. Depends on the validated cert so the
# listener can't come up before the cert is usable.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
